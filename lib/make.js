var Vow = require('vow');
var Node = require('./node');
var path = require('path');
var Logger = require('./logger');
var colors = require('./ui/colorize');
var ProjectConfig = require('./config/project-config');
var Cache = require('./cache/cache');
var CacheStorage = require('./cache/cache-storage');
var inherit = require('inherit');
var vowFs = require('./fs/async-fs');
var fs = require('fs');
var BuildGraph = require('./ui/build-graph');
var TargetNotFoundError = require('./errors/target-not-found-error');
var dropRequireCache = require('./fs/drop-require-cache');

/**
 * MakePlatform
 * ============
 *
 * Класс MakePlatform управляет сборкой проекта.
 * В процессе инициализации загружается {CWD}/.bem/enb-make.js, в котором содержатся правила сборки.
 * @name MakePlatform
 * @class
 */
module.exports = inherit( /** @lends MakePlatform.prototype */ {

    /**
     * Конструктор.
     */
    __constructor: function () {
        this._nodes = {};
        this._nodeInitPromises = {};
        this._cacheStorage = null;
        this._cache = null;
        this._projectConfig = null;
        this._cdir = null;
        this._languages = null;
        this._env = {};
        this._mode = null;
        this._makefiles = [];
        this._graph = null;
        this._levelNamingSchemes = {};
    },

    /**
     * Инициализация make-платформы.
     * Создает директорию для хранения временных файлов, загружает конфиг для сборки.
     * @param {String} cdir Путь к директории с проектом.
     * @param {String} [mode] Режим сборки. Например, development.
     * @returns {Promise}
     */
    init: function (cdir, mode) {
        this._mode = mode = mode || process.env.YENV || 'development';

        this._cdir = cdir;

        var _this = this;
        var projectName = path.basename(cdir);
        var configDir = this._getConfigDir();
        var makefilePath = this._getMakeFile('make');
        var personalMakefilePath = this._getMakeFile('make.personal');

        if (!makefilePath) {
            throw new Error('Cannot find make configuration file.');
        }

        this._projectName = projectName;
        this._logger = new Logger();
        this._buildState = {};
        this._makefiles = [makefilePath, personalMakefilePath];
        this._graph = new BuildGraph(projectName);

        var projectConfig = this._projectConfig = new ProjectConfig(cdir);

        try {
            dropRequireCache(require, makefilePath);
            require(makefilePath)(projectConfig);
        } catch (err) {
            return Vow.reject(err);
        }

        if (personalMakefilePath) {
            dropRequireCache(require, personalMakefilePath);
            require(personalMakefilePath)(projectConfig);
        }

        this._makefiles = this._makefiles.concat(projectConfig.getIncludedConfigFilenames());

        var modeConfig = projectConfig.getModeConfig(mode);
        if (modeConfig) {
            modeConfig.exec(null, projectConfig);
        }

        this._languages = projectConfig.getLanguages();
        this._env = projectConfig.getEnvValues();
        this._levelNamingSchemes = projectConfig.getLevelNamingSchemes();

        projectConfig.task('clean', function (task) {
            return task.cleanTargets([].slice.call(arguments, 1));
        });

        var tmpDir = configDir + '/tmp';

        return vowFs.makeDir(tmpDir).then(function () {
            _this._cacheStorage = new CacheStorage(tmpDir + '/cache.js');
            _this._nodes = {};
        });
    },

    /**
     * Возвращает абсолютный путь к директории с проектом.
     * @returns {String}
     */
    getDir: function () {
        return this._cdir;
    },

    /**
     * Возвращает абсолютный путь к директории с конфигурационными файлами.
     * В качестве директории ожидается либо .enb/, либо .bem/.
     * @returns {string}
     * @private
     */
    _getConfigDir: function () {
        var cdir = this.getDir();
        var possibleDirs = ['.enb', '.bem'];
        var configDir;
        var isConfigDirExists = possibleDirs.some(function (dir) {
            configDir = path.join(cdir, dir);
            return fs.existsSync(configDir);
        });
        if (isConfigDirExists) {
            return configDir;
        } else {
            throw new Error('Cannot find enb config directory. Should be either .enb/ or .bem/.');
        }
    },

    /**
     * Возвращает путь к указанному конфигу сборки.
     * Если файлов make.js и make.personal.js не существует, то пробуем искать файлы с префиксом enb-.
     * @param {String} file Название конфига (основной или персональный).
     * @returns {String}
     * @private
     */
    _getMakeFile: function (file) {
        var configDir = this._getConfigDir();
        var possiblePrefixes = ['enb-', ''];
        var makeFile;
        var isMakeFileExists = possiblePrefixes.some(function (prefix) {
            makeFile = path.join(configDir, prefix + file + '.js');
            return fs.existsSync(makeFile);
        });
        if (isMakeFileExists) {
            return makeFile;
        }
    },

    /**
     * Возвращает построитель графа сборки.
     * @returns {BuildGraph}
     */
    getBuildGraph: function () {
        return this._graph;
    },

    /**
     * Загружает кэш из временной папки.
     * В случае, если обновился пакет enb, либо изменился режим сборки, либо изменились make-файлы, сбрасывается кэш.
     */
    loadCache: function () {
        this._cacheStorage.load();
        var version = require('../package.json').version;
        var mtimes = this._cacheStorage.get(':make', 'makefiles') || {};
        var dropCache = false;
        // Invalidate cache if mode was changed.
        if (this._cacheStorage.get(':make', 'mode') !== this._mode) {
            dropCache = true;
        }
        // Invalidate cache if ENB package was updated.
        if (this._cacheStorage.get(':make', 'version') !== version) {
            dropCache = true;
        }
        // Invalidate cache if any of makefiles were updated.
        var currentMTimes = this._getMakefileMTimes();
        Object.keys(currentMTimes).forEach(function (makefilePath) {
            if (currentMTimes[makefilePath] !== mtimes[makefilePath]) {
                dropCache = true;
            }
        });
        if (dropCache) {
            this._cacheStorage.drop();
        }
    },

    /**
     * Возвращает время изменения каждого загруженного make-файла в виде unix-time (.bem/enb-make.js).
     * @returns {Object}
     * @private
     */
    _getMakefileMTimes: function () {
        var res = {};
        this._makefiles.forEach(function (makefilePath) {
            if (fs.existsSync(makefilePath)) {
                res[makefilePath] = fs.statSync(makefilePath).mtime.getTime();
            }
        });
        return res;
    },

    /**
     * Сохраняет кэш во временную папку.
     */
    saveCache: function () {
        this._cacheStorage.set(':make', 'mode', this._mode);
        this._cacheStorage.set(':make', 'version', require('../package.json').version);
        this._cacheStorage.set(':make', 'makefiles', this._getMakefileMTimes());
        this._cacheStorage.save();
    },

    /**
     * Возвращает переменные окружения.
     * @returns {Object}
     */
    getEnv: function () {
        return this._env;
    },

    /**
     * Устанавливает переменные окружения.
     * @param {Object} env
     */
    setEnv: function (env) {
        this._env = env;
    },

    /**
     * Возвращает хранилище кэша.
     * @returns {CacheStorage}
     */
    getCacheStorage: function () {
        return this._cacheStorage;
    },

    /**
     * Устанавливает хранилище кэша.
     * @param {CacheStorage} cacheStorage
     */
    setCacheStorage: function (cacheStorage) {
        this._cacheStorage = cacheStorage;
    },

    /**
     * Возвращает языки для проекта.
     * Вроде, уже больше не нужно. Надо избавиться в будущих версиях.
     * @returns {String[]}
     * @deprecated
     */
    getLanguages: function () {
        return this._languages;
    },

    /**
     * Устанавливает языки для проекта.
     * Вроде, уже больше не нужно. Надо избавиться в будущих версиях.
     * @param {String[]} languages
     * @deprecated
     */
    setLanguages: function (languages) {
        this._languages = languages;
    },

    /**
     * Возвращает логгер для сборки.
     * @returns {Logger}
     */
    getLogger: function () {
        return this._logger;
    },

    /**
     * Устанавливает логгер для сборки.
     * Позволяет перенаправить вывод процесса сборки.
     *
     * @param {Logger} logger
     */
    setLogger: function (logger) {
        this._logger = logger;
    },

    /**
     * Инициализирует ноду по нужному пути.
     * @param {String} nodePath
     * @returns {Promise}
     */
    initNode: function (nodePath) {
        if (!this._nodeInitPromises[nodePath]) {
            var _this = this;
            var cdir = this.getDir();
            var nodeConfig = this._projectConfig.getNodeConfig(nodePath);
            var node = new Node(nodePath, this, this._cache);
            node.setLogger(this._logger.subLogger(nodePath));
            node.setBuildGraph(this._graph);
            this._nodes[nodePath] = node;
            this._nodeInitPromises[nodePath] = vowFs.makeDir(path.join(cdir, nodePath))
                .then(function () {
                    return Vow.when(nodeConfig.exec());
                })
                .then(function () {
                    return Vow.all(_this._projectConfig.getNodeMaskConfigs(nodePath).map(function (nodeMaskConfig) {
                        return nodeMaskConfig.exec([], nodeConfig);
                    }));
                })
                .then(function () {
                    var mode = nodeConfig.getModeConfig(_this._mode);
                    return mode && mode.exec(null, nodeConfig);
                })
                .then(function () {
                    node.setLanguages(nodeConfig.getLanguages() || _this._languages);
                    node.setTargetsToBuild(nodeConfig.getTargets());
                    node.setTargetsToClean(nodeConfig.getCleanTargets());
                    node.setTechs(nodeConfig.getTechs());
                    node.setBuildState(_this._buildState);
                    return node.loadTechs();
                });
        }
        return this._nodeInitPromises[nodePath];
    },

    /**
     * Требует сборки таргетов для указанной ноды.
     * @param {String} nodePath Например, "pages/index".
     * @param {String[]} sources Таргеты, которые необходимо собрать.
     * @returns {Promise}
     */
    requireNodeSources: function (nodePath, sources) {
        var _this = this;
        return this.initNode(nodePath).then(function () {
            return _this._nodes[nodePath].requireSources(sources);
        });
    },

    /**
     * Сбрасывает кэш.
     */
    dropCache: function () {
        this._cacheStorage.drop();
    },

    /**
     * Возвращает массив строк путей к нодам, упорядоченные по убыванию длины.
     * Сортировка по убыванию нужна для случаев, когда на файловой системе одна нода находится
     * внутри другой (например, `bundles/page` и `bundles/page/bundles/header`).
     *
     * @returns {String[]}
     * @private
     */
    _getNodePathsLenDesc: function () {
        return Object.keys(this._projectConfig.getNodeConfigs()).sort(function (a, b) {
            return b.length - a.length;
        });
    },

    /**
     * Вычисляет (на основе переданного пути к таргету и списка путей к нодам)
     *  к какой ноде принадлежит переданный таргет.
     * @param {String} target
     * @param {String[]} nodePaths
     * @returns {{node: *, targets: String[]}}
     * @private
     */
    _resolveTarget: function (target, nodePaths) {
        target = target.replace(/^(\.\/)+/g, '');
        for (var i = 0, l = nodePaths.length; i < l; i++) {
            var nodePath = nodePaths[i];
            if (target.indexOf(nodePath) === 0) {
                var npl = nodePath.length;
                var charAtNpl = target.charAt(npl);
                if (target.length === npl) {
                    return {
                        node: nodePath,
                        targets: ['*']
                    };
                } else if (charAtNpl === '/' || charAtNpl === '\\') {
                    return {
                        node: nodePath,
                        targets: [target.substr(npl + 1)]
                    };
                }
            }
        }
        throw TargetNotFoundError('Target not found: ' + target);
    },

    /**
     * Вычисляет для списка таргетов, к каким нодам они принадлежат.
     * @param {String[]} targets
     * @returns {Object[]}
     * @private
     */
    _resolveTargets: function (targets) {
        var _this = this;
        var buildTargets = [];
        var nodeConfigs = this._projectConfig.getNodeConfigs();
        var nodePathsDesc = this._getNodePathsLenDesc();
        if (targets.length) {
            var targetIndex = {};
            targets.forEach(function (targetName) {
                var target = _this._resolveTarget(targetName, nodePathsDesc);
                if (targetIndex[target.node]) {
                    var currentTargetList = targetIndex[target.node].targets;
                    target.targets.forEach(function (resTargetName) {
                        if (currentTargetList.indexOf(resTargetName) === -1) {
                            currentTargetList.push(resTargetName);
                        }
                    });
                } else {
                    targetIndex[target.node] = target;
                    buildTargets.push(target);
                }
            });
        } else {
            Object.keys(nodeConfigs).forEach(function (nodePath) {
                buildTargets.push({
                    node: nodePath,
                    targets: ['*']
                });
            });
        }
        return buildTargets;
    },

    /**
     * Запускает сборку переданного списка таргетов.
     * @param {String[]} targets
     * @returns {Promise}
     */
    buildTargets: function (targets) {
        var _this = this;
        this._cache = new Cache(this._cacheStorage, this._projectName);
        try {
            var targetList = this._resolveTargets(targets);
            return Vow.all(targetList.map(function (target) {
                return _this.initNode(target.node);
            })).then(function () {
                return Vow.all(targetList.map(function (target) {
                    return _this._nodes[target.node].build(target.targets);
                })).then(function (builtInfoList) {
                    var builtTargets = [];

                    builtInfoList.forEach(function (builtInfo) {
                        builtTargets = builtTargets.concat(builtInfo.builtTargets);
                    });

                    return {
                        builtTargets: builtTargets
                    };
                });
            });
        } catch (err) {
            return Vow.reject(err);
        }
    },

    /**
     * @returns {ProjectConfig}
     */
    getProjectConfig: function () {
        return this._projectConfig;
    },

    /**
     * Запускает удаление переданного списка таргетов.
     * @param {String[]} targets
     * @returns {Promise}
     */
    cleanTargets: function (targets) {
        var _this = this;
        this._cache = new Cache(this._cacheStorage, this._projectName);
        try {
            var targetList = this._resolveTargets(targets);
            return Vow.all(targetList.map(function (target) {
                return _this.initNode(target.node);
            })).then(function () {
                return Vow.all(targetList.map(function (target) {
                    return _this._nodes[target.node].clean(target.targets);
                }));
            });
        } catch (err) {
            return Vow.reject(err);
        }
    },

    /**
     * Запускает выполнение таска.
     * @param {String} taskName
     * @param {String[]} args
     * @returns {Promise}
     */
    buildTask: function (taskName, args) {
        var task = this._projectConfig.getTaskConfig(taskName);
        task.setMakePlatform(this);
        return Vow.when(task.exec(args));
    },

    /**
     * Деструктор.
     */
    destruct: function () {
        this._buildState = null;
        delete this._projectConfig;
        var nodes = this._nodes;
        Object.keys(nodes).forEach(function (nodeName) {
            nodes[nodeName].destruct();
        });
        delete this._nodes;
        if (this._cacheStorage) {
            this._cacheStorage.drop();
            delete this._cacheStorage;
        }
        if (this._cache) {
            this._cache.destruct();
            delete this._cache;
        }
        delete this._levelNamingSchemes;
    },

    /**
     * Запускает сборку.
     * Может запустить либо сборку таргетов, либо запуск тасков.
     * @param {String[]} targets
     * @returns {Promise}
     */
    build: function (targets) {
        var promise = Vow.promise();
        var startTime = new Date();
        var _this = this;
        var targetTask;
        try {
            this._logger.log('build started');
            if (targets.length && this._projectConfig.getTaskConfig(targets[0])) {
                targetTask = this.buildTask(targets[0], targets.slice(1));
            } else {
                targetTask = this.buildTargets(targets);
            }
            targetTask.then(function () {
                _this._logger.log('build finished - ' + colors.red((new Date() - startTime) + 'ms'));
                Object.keys(_this._nodes).forEach(function (nodeName) {
                    _this._nodes[nodeName].getLogger().setEnabled(false);
                });
                promise.fulfill();
            }, function (err) {
                _this._logger.log('build failed');
                promise.reject(err);
            });
        } catch (err) {
            promise.reject(err);
        }
        return promise;
    },

    /**
     * Возвращает схему именования для уровня переопределения.
     * Схема именования содержит два метода:
     * ```javascript
     * // Выполняет построение структуры файлов уровня переопределения, используя методы инстанции класса LevelBuilder.
     * {Promise} buildLevel( {String} levelPath, {LevelBuilder} levelBuilder )
     * // Возвращает путь к файлу на основе пути к уровню переопределения и BEM-описания.
     * {String} buildFilePath(
     *     {String} levelPath, {String} blockName, {String} elemName, {String} modName, {String} modVal
     * )
     * ```
     * @returns {Object|undefined}
     */
    getLevelNamingScheme: function (levelPath) {
        return this._levelNamingSchemes[levelPath];
    }
});
