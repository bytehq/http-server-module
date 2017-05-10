'use strict';

var _ = require('lodash');
var cheerio = require('cheerio');
var EventEmitter = require('events');
var fs = require('fs');
var path = require('path');

var MinimalClient = require('./client-minimal');
var roomValidator = require('./room-validator.js');
var url = require('url');

const { buildMessage } = require('./util');
const { RpcHandler } = require('./rpc');
const { VMDocument, getDocument$ } = require('./dom');

/*
 *  gRPC
 */
var PROTO_PATH = __dirname + '/interspace.proto';
var grpc = require('grpc');
var interspace_proto = grpc.load(PROTO_PATH).interspace;

/*
 *  gRPC-Bus
 */
var grpcBus = require('grpc-bus');
var protobuf = require('protobufjs');
var gbBuilder = protobuf.loadProtoFile(__dirname + '/grpc-bus.proto');
var gbTree = gbBuilder.build().grpcbus;
var WebSocketServer = require('ws').Server;

/*
 * Global State
 */
var world;
var staticPath;
var coprManagerClient;
var broadcastPublisher;

class InterspaceServer {

    constructor(options, callback) {
        // Parse and Validate options
        options = Object.assign({
            'server': null,
            'coprAddress': null,
            'localAddress': null,
            'localPort': null,
            'staticPath': null,
            'roomStateRPCPort': 50052
        }, options);

        if (!options.server || !options.coprAddress || !options.localAddress || !options.localPort || !options.staticPath) {
            throw new TypeError('missing or invalid options');
        }

        this.options = options;

        // Set Room State Proxy Address (for WS Server)
        const localURL = url.parse(options.localAddress);
        this.roomStateProxyAddress = 'ws://' + localURL.hostname + ':' + options.localPort;

        // Set up World State
        world = {};
        staticPath = options.staticPath;

        // Initialise COPR Manager gRPC Client
        this.coprManagerClient = new interspace_proto.COPRManager(
            options.coprAddress,
            grpc.credentials.createInsecure()
        );

        // Initialise Room State gRPC Server
        this.roomStateServer = new grpc.Server();
        this.roomStateServer.addService(interspace_proto.RoomState.service, {
            terraform: terraform,
            pickup: pickup,
            rpcCall: rpcCall,
            broadcastMessage: broadcastMessage,
            roomStateMessage: roomStateMessage
        });
        this.roomStateServer.bind(
            '0.0.0.0:' + 50052,
            grpc.ServerCredentials.createInsecure()
        );
        this.roomStateServer.start();

        // Initialise WS Proxy Server
        // Proxies incoming requests to localhost gRPC server
        this.wss = new WebSocketServer({ 'server': options.server });
        this.wss.on('connection', function connection(ws) {
            ws.once('message', function incoming(data, flags) {
                var message = JSON.parse(data);
                var protoFileExt = message.filename.substr(message.filename.lastIndexOf('.') + 1);
                var protoDefs;
                if (protoFileExt === 'json') {
                    protoDefs = protobuf.loadJson(message.contents, null, message.filename);
                } else {
                    protoDefs = protobuf.loadProto(message.contents, null, message.filename);
                }

                var gbServer = new grpcBus.Server(protoDefs, function(message) {
                    var pbMessage = new gbTree.GBServerMessage(message);
                    ws.send(pbMessage.toBuffer());
                }, require('grpc'));

                ws.on('message', function incoming(data, flags) {
                    var message = gbTree.GBClientMessage.decode(data);
                    gbServer.handleMessage(message);
                });
            });
        });
    }

    getCOPRServer(room, cb) {
        try {
            this.coprManagerClient.getServer({
                    'roomId': room,
                    'roomStateServerAddress': this.roomStateProxyAddress,
                    'roomStateRPCPort': this.options.roomStateRPCPort
                },
                cb
            );
        } catch (err) {
            console.log('getCOPRServer: ' + err);
        }
    }

    initialiseWorldState(room, cb) {
        // Set up World state if this is the first time the room has been loaded
        if (!world[room]) {
            // TODO just make a Room object already
            var roomEvents = new EventEmitter();
            world[room] = {
                id: room,
                states: {},
                broadcast: function(msgType, data) {
                    var message = buildMessage(room, msgType, data);

                    if (!broadcastPublisher) {
                        console.warn(
                            'Unitialized broadcastPublisher (message: ' + message + ')'
                        );
                        return;
                    }

                    broadcastPublisher.write({
                        'roomId': room,
                        'message': message
                    });
                },
                on: roomEvents.on.bind(roomEvents),
                emit: roomEvents.emit.bind(roomEvents)
            };
            world[room].rpc = new RpcHandler(world[room], staticPath);
        }

        cb(null);
    }

    shutdown() {
        if (broadcastPublisher) broadcastPublisher.end();
    }
}

/*
 * Room state functions
 */
function terraform(call, callback) {
    console.log('Terraform message received');

    var roomId;
    var instructions = [];

    call.on('data', function(terraformRequest) {
        if (terraformRequest.roomId) {
            roomId = terraformRequest.roomId;
        } else {
            instructions.push(terraformRequest.instruction);
        }
    });

    // All Terraform instructions have been received
    call.on('end', function() {
        callback(null, {});

        fs.readFile(
            roomValidator.pathToPlanetFromRoom(roomId, staticPath),
            'utf8',
            function(err, data) {
                if (err) {
                    console.error('Terraform load failed: ' + err);
                    return;
                }
                var doc = new VMDocument(data);
                var terrain = getDocument$(doc)('terrain');
                if (terrain && terrain.attr('terraform')) {
                    // TODO: check if we can edit the terraform file
                    var lastTerraformFile = terrain.attr('terraform');
                    var path = __dirname + '/public/' + lastTerraformFile;
                    fs.appendFile(
                        path,
                        '\n' + instructions.join('\n'),
                        function(err) {
                            if (err) {
                                // TODO
                                console.error('Terraform write failed: ' + err);
                            }
                        }
                    );
                }
            }
        );
    });
}

function pickup(call, callback) {
    console.log('Pickup message received');

    var roomId = call.request.roomId;
    var elementId = call.request.elementId;
    var uuid = call.request.uuid;

    var planetPath = roomValidator.pathToPlanetFromRoom(roomId, staticPath);
    fs.readFile(planetPath, 'utf8', function(err, data) {
        if (err) {
            callback('Unable to read planet at ' + planetPath, null);
            return;
        }

        var $ = cheerio.load(data, { xmlMode: true });
        var node = $('#' + elementId);
        if (
            node !== null &&
            node.attr('pickup') !== null &&
            node.attr('pickup').toLowerCase() == 'true'
        ) {
            callback(null, {
                'validForPickup': true,
                'x': parseFloat(node.children().first().attr('x')) || 0,
                'y': parseFloat(node.children().first().attr('y')) || 0,
                'z': parseFloat(node.children().first().attr('z')) || 0,
                'rotationX': parseFloat(node.children().first().attr('rotationX')) || 0,
                'rotation': parseFloat(node.children().first().attr('rotation')) || 0,
                'rotationZ': parseFloat(node.children().first().attr('rotationZ')) || 0
            });
        } else {
            callback(null, {
                'validForPickup': false
            });
        }
    });
}

function rpcCall(call, callback) {
    console.log('RPCCall message received');

    var client = {
        'uuid': call.request.senderUUID
    };
    var args = JSON.parse(call.request.args);
    world[call.request.roomId].rpc.invoke(client, args);

    callback(null, {});
}

function broadcastMessage(call) {
    console.log('BroadcastMessage initialiser received');

    broadcastPublisher = call;
}

function roomStateMessage(call, callback) {
    console.log('RoomState message received');

    call.on('data', function(message) {
        var roomId = message.roomId;
        var uuid = message.uuid;

        switch (message.type) {
            case 'join':
                var client = new MinimalClient(uuid);
                world[roomId].states[uuid] = client;
                world[roomId].emit('join', client);
                break;
            case 'update':
                var current = world[roomId].states[uuid];
                if (!current) break;
                current.updateState({
                    'x': message.x,
                    'y': message.y,
                    'z': message.z
                });
                break;
            case 'leave':
                world[roomId].emit('leave');
                delete world[roomId].states[uuid];
                break;
        }
    });
    call.on('end', function() {
        callback(null, {});
    });
}

module.exports = InterspaceServer;