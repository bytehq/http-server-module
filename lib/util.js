module.exports = {};

module.exports.buildMessage = function buildMessage(room, message, data) {
    data = data || {};
    var out = message + ' ' + JSON.stringify(data, function replacer(k, v) {
        if (k.charAt(0) == '_') return; // drop internal fields
        return v;
    });
    return out;
};