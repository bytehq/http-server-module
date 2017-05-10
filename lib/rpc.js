/**
 * RPC handling
 */

var EventEmitter = require('events');
var fs = require('fs');
var path = require('path');
var Promise = require('promise');
var readFile = Promise.denodeify(fs.readFile);
var roomValidator = require('./room-validator');

const { VM } = require('vm2');
const {
    getDocument$,
    AudioClip,
    CollisionList,
    Ray,
    Vector3,
    VMDocument,
    VMWindow,
} = require('./dom');
const { RpcArguments } = require('./rpc-types');

class GlobalRateLimiter {

    constructor(config) {
        this.config = config;
    }

    /**
     * @return True if the limiter allows the rpc call
     */
    allows( /* sender, rpcArgs */ ) {
        var rpcConfig = this.config;
        var now = Date.now();
        if (!this.last || now - this.last > 1000) {
            // first call, or clean new window
            this.last = now;
            this.calls = 1;
        } else if (++this.calls > rpcConfig.maxRate) {
            // you've gone too far!
            return false;
        }

        // if we make it here, they're good to go
        return true;
    }

}

class PerUserRateLimiter {

    constructor(config) {
        this.config = config;
        this.clients = {};
    }

    /**
     * @return True if the limiter allows the rpc call
     */
    allows(sender, rpcArgs) {
        // basically just build a separate limiter per user and evaluate against it
        var userLimiter = this.clients[sender.uuid];
        if (!userLimiter) {
            userLimiter = this.clients[sender.uuid] = new GlobalRateLimiter(this.config);
        }

        return userLimiter.allows(sender, rpcArgs);
    }
}

class VMClient extends EventEmitter {
    constructor(realClient) {
        super();
        this.run = function run(fnName) {
            var args = Array.from(arguments);
            args.shift(); // pop off `fn`
            realClient.send('rpc', {
                fn: fnName,
                on: 'clients',
                args: RpcArguments.serialize(args)
            });
        };

        realClient.on('leave', () => {
            this.emit('leave');
        });

        Object.defineProperties(this, {
            id: {
                get: () => realClient.uuid,
                enumerable: true
            },

            position: {
                get: () => new Vector3(
                    realClient.state.x,
                    realClient.state.y,
                    realClient.state.z),
                enumerable: true
            },
        });
    }
}

class VMClients extends EventEmitter {

    constructor(interspaceModule, room) {
        super();
        this.type = 'clients';

        // NOTE: We define like this to avoid leaking a reference
        // to the room object
        this.byId = function byId(id) {
            // TODO reuse the VMClient instance
            return new VMClient(room.states[id]);
        };
        this.run = function run(fnName) {
            var args = Array.from(arguments);
            args.shift(); // pop off `fnName`
            room.broadcast('rpc', {
                fn: fnName,
                on: 'clients',
                args: RpcArguments.serialize(args)
            });
        };

        this.open = interspaceModule.__internal.open.bind(interspaceModule.__internal, this);

        interspaceModule.clients = this;
    }
}

class VMServer extends EventEmitter {

    constructor(interspaceModule) {
        super();
        this.type = 'server';

        this.open = interspaceModule.__internal.open.bind(interspaceModule.__internal, this);

        // NOTE: We define like this to avoid leaking a reference
        // to the interspaceModule object
        this.run = function run(fnName) {
            var fn = interspaceModule.__internal.registeredFunctions.server[fnName];
            var args = Array.from(arguments);
            args.shift(); // pop off `fnName`
            fn.apply(fn, args);
        };

    }
}

class InternalInterspaceModule {

    constructor() {
        this.registeredFunctions = {
            clients: {},
            server: {}
        };
    }

    open(src, name, opts, fn) {
        if (!fn) {
            if (!opts) {
                // just fn
                fn = name;
                name = fn.name;
                opts = undefined;
            } else if (typeof(name) === 'string') {
                // 'name', fn
                fn = opts;
                opts = undefined;
            } else {
                // {opts}, fn
                fn = opts;
                opts = undefined;
                name = fn.name;
            }
        }

        if (!name || typeof(name) !== 'string') {
            throw new Error("You must provide either a name string or a named function; got `" + JSON.stringify(name) + "`" + "; " + opts + "; " + fn);
        }

        // NOTE: we could potentially let clients provide
        //  their own rate limiter...
        var config = this._buildConfig(opts);
        this.registeredFunctions[src.type][name] = {
            config: config,
            limiter: new PerUserRateLimiter(config),
            fn: fn
        };

        return src.run.bind(src, name);
    }

    _buildConfig(opts) {
        var config = {
            maxRate: 5,
            unreliable: false
        };
        if (opts) Object.assign(config, opts);
        return config;
    }
}

class InterspaceModule {
    constructor() {
        this.__internal = new InternalInterspaceModule();
    }
}

class VMGlobal {
    constructor(handler, room, staticPath) {
        var self = this;
        this.room = room;
        this.staticPath = staticPath;

        var interspaceModule = new InterspaceModule();
        var consolePrefix = `JS(${room.id})>`;
        this.public = {
            clients: new VMClients(interspaceModule, room),
            server: new VMServer(interspaceModule),
            document: null, // to be filled in setDocumentXml
            window: new VMWindow(room, staticPath),
            console: {
                log: console.log.bind(console, consolePrefix),
                warn: console.warn.bind(console, consolePrefix),
            },
            interspace: interspaceModule,
            setTimeout: setTimeout,
            clearTimeout: clearTimeout,
            setInterval: setInterval,
            clearInterval: clearInterval,
            showMessage: function showMessage(text /* , duration=2500 */ ) {
                console.log(consolePrefix + "Message> ", text);
            },

            AudioClip: AudioClip,
            CollisionList: CollisionList,
            Ray: Ray,
            Vector3: Vector3,

            player: null,
        };

        // init'd later once document is ready
        this._vm = null;

        room.on('join', client => {
            // don't emit the event until the scripts have loaded
            handler.loaded().then(() => {
                self.public.clients.emit('join', new VMClient(client));
            });
        });
    }

    /**
     * Run the given function with the given arguments in the shared VM
     */
    run(sender, fn, args) {
        var argsAsString = RpcHandler.readArgsToString(args);
        var argsPrefix = "";
        if (argsAsString) {
            argsPrefix = ", ";
        }

        var call = "interspace.__internal.registeredFunctions.server" +
            `["${fn}"].fn.call(` +
            `{sender: interspace.clients.byId("${sender.uuid}")}` +
            `${argsPrefix}${argsAsString})`;
        try {
            this._vm.run(call);
        } catch (e) {
            console.error(`ERROR invoking RPC call ${fn}(${argsAsString}):`);
            console.error(e.stack);
        }
    }

    registeredFunction(type, name) {
        return this.public.interspace.__internal.registeredFunctions[type][name];
    }

    setDocumentXml(xmlData) {
        var room = this.room;
        var doc = this.public.document = new VMDocument(xmlData);
        var $ = getDocument$(doc);
        var scripts = $('script');
        var vm = this._vm = new VM({
            timeout: 2000,
            require: false,
            sandbox: this.public
        });

        // yuck? yuck
        var documentDir = path.parse(
            roomValidator.pathToPlanetFromRoom(room.id, this.staticPath)
        ).dir + '/';

        var tasks = scripts.map(function() {
            var el = $(this);
            var src = el.attr('src');
            if (src) {
                var path = documentDir + src;
                return readFile(path, 'utf8')
                    .then((data) => {
                        var javascript = data.toString();
                        console.log("RUN FROM", src);
                        vm.run(javascript, src);
                        return true;
                    });
            } else {
                var javascript = el.text();
                return new Promise((resolve) => {
                    vm.run(javascript, room);
                    resolve(true);
                });
            }
        });

        return Promise.all(tasks);
    }
}

class RpcHandler {

    constructor(room, staticPath) {
        this.room = room;
        this.staticPath = staticPath;

        this._promise = this._loadFunctions();
        this._global = new VMGlobal(this, room, staticPath);
    }

    /**
     * Returns a Promise that resolves when
     *  we've finished loading (or right away
     *  if we have already loaded)
     */
    loaded() {
        return this._promise;
    }

    /**
     * @param sender The Client who requested the RPC
     * @param args The RPC arguments
     */
    invoke(sender, args) {
        // validate the target
        if (args.on !== 'server') {
            console.warn(`DROP ${args.on}.${args.fn}: invalid execution target ${args.on}`);
            return;
        }

        // fetch the function info (and make sure it exists)
        var rpcInfo = this._global.registeredFunction(args.on, args.fn);
        if (!rpcInfo) {
            console.warn(`DROP ${args.on}.${args.fn}: unknown`);
            return;
        }

        // validate against rpcConfig
        if (!rpcInfo.limiter.allows(sender, args)) {
            console.warn(`DROP ${args.on}.${args.fn}: rate limiter`);
            return;
        }

        // LGTM!
        this._global.run(sender, args.fn, args.args);
    }

    _loadFunctions() {
        var self = this;
        var room = this.room.id;
        console.log("LOAD", room);
        return readFile(roomValidator.pathToPlanetFromRoom(room, this.staticPath), 'utf8')
            .then(function(elementsData) {
                // load in the data
                return self._global.setDocumentXml(elementsData);
            })
            .then(function() {
                console.log(`Done loading ${room} successfully!`);
                self._global.public.server.emit('ready');
            }, function(rejection) {
                console.warn(room, "loading failed:", rejection);
            });
    }

    static readArgsToString(serializedArgs) {
        return RpcArguments.read(serializedArgs).map(arg => {
            if (typeof(arg) === 'string') {
                // safety first:
                arg = arg.replace("'", "\\'");
                return `'${arg}'`;
            }

            return JSON.stringify(arg);
        }).join(',');
    }

}

module.exports = {
    RpcHandler,

    // exported for testing:
    VMClients,
    InterspaceModule
};