// validates that a room name is valid by checking if the .json file exists
// probably better ways to do this, since it'll break completely for any
// sort of dynamic worlds

var fs = require('fs');
var path = require('path');

var roomValidator = {
    pathToPlanetFromRoom: function(room, staticPath) {
        return staticPath + '/public' + room;
    },

    roomNameIsValid: function(room, staticPath) {
        try {
            var filePath = this.pathToPlanetFromRoom(room, staticPath);
            fs.accessSync(filePath);
            if (path.extname(room) == '.iml') {
                return true;
            }
            return false;
        } catch (e) {
            console.error(e);
            return false;
        }
    }
};

exports.pathToPlanetFromRoom = roomValidator.pathToPlanetFromRoom;
exports.roomNameIsValid = roomValidator.roomNameIsValid;