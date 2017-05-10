'use strict';

var EventEmitter = require('events');
var _ = require('lodash');

/**
 * Events:
 *  - leave(): emitted on disconnect
 */
class MinimalClient extends EventEmitter {
    constructor(uuid) {
        super();

        this.uuid = uuid;
        this.state = {
            x: 0,
            y: 0,
            z: 0
        };
    }

    updateState(newState) {
        var current = this.state;
        newState = _.merge({
            x: current.x,
            y: current.y,
            z: current.z
        }, newState);

        if (
            current.x === newState.x &&
            current.y === newState.y &&
            current.z === newState.z
        ) {
            return;
        }

        this.state = newState;
    }
}

module.exports = MinimalClient;