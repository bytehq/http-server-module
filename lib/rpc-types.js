const { Vector3 } = require('./dom');

class RpcTypes {
    static nameFor(obj) {
        if (!obj) return null;
        if (obj instanceof Vector3) return 'v3';
        if (Array.isArray(obj)) return 'a';
        if (typeof(obj) === 'object') return 'o';
    }

    static read(typeName, serialized) {
        // NOTE: serialized is the whole array with the type removed
        switch (typeName) {
            case 'a':
                return RpcArguments.read(serialized[0]);

            case 'o':
                var keys = RpcArguments.read(serialized[0]);
                var vals = RpcArguments.read(serialized[1]);
                return keys.reduce((obj, key, index) => {
                    obj[key] = vals[index];
                    return obj;
                }, {});

            case 'v3':
                var vector = RpcArguments.read(serialized[0]);
                return new Vector3(vector[0], vector[1], vector[2]);
        }

        throw new Error("Unable to read " + typeName);
    }

    static serialize(obj) {
        var typeName = RpcTypes.nameFor(obj);
        if (!typeName) return obj; // just return it directly

        var result = [typeName];
        switch (typeName) {
            case 'a':
                result.push(RpcArguments.serialize(obj));
                break;

            case 'o':
                var keys = Object.keys(obj);
                result.push(RpcArguments.serialize(keys));
                result.push(RpcArguments.serialize(keys.map(key => {
                    return obj[key];
                })));
                break;

            case 'v3':
                result.push(RpcArguments.serialize(obj.x, obj.y, obj.z));
                break;

            default:
                throw new Error("No way to serialize " + obj);
        }

        return result;
    }
}

class RpcArguments {
    static read(serializedArgs) {
        if (!serializedArgs) return [];

        // just return it directly for now
        return serializedArgs.map(rawArg => {
            if (!Array.isArray(rawArg)) return rawArg;
            var typeName = rawArg[0];
            rawArg.shift();
            return RpcTypes.read(typeName, rawArg);
        });
    }

    static serialize(args) {
        if (!(arguments.length === 1 && Array.isArray(args))) {
            args = Array.from(arguments);
        }

        if (args.length === 0) return null;
        return args.map(RpcTypes.serialize);
    }
}

module.exports = {
    RpcTypes,
    RpcArguments
};