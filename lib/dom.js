/**
 * Virtual DOM for server-side scripting
 */

const EventEmitter = require('events');
const cheerio = require('cheerio');
const roomValidator = require('./room-validator');

/* WeakMaps to store things that should not be leaked into the VM */
let DocumentTo$ = new WeakMap();
let ElementToCheerio = new WeakMap();

/**
 * Get the cheerio $ instance for a document
 */
function getDocument$(document) {
    return DocumentTo$[document];
}

const NODE_ATTRIBS = {
    'a': ['href', 'title'],
    'home': ['title'],
    'img': ['src', 'title'],
    'rigidbody': ['pickup'],
};

function _warnNotImplemented(name) {
    console.warn(new Error(`${name} is not implemented on the server`).stack);
}

function _notImplementedProp(name) {
    return _warnNotImplemented.bind(null, name);
}

const NODE_PROPDEFS = {
    'audio': {
        play: _notImplementedProp("AudioClip.play"),
        pause: _notImplementedProp("AudioClip.pause"),
    },
    'mesh': {
        lookAt: _notImplementedProp("Mesh.lookAt")
    },
    'rigidbody': {
        impulse: _notImplementedProp("Rigidbody.impulse")
    }
};

class AudioClip {
    constructor( /* src */ ) {}

    attachTo( /* obj */ ) {
        _warnNotImplemented("AudioClip.attachTo");
    }

    pause() {
        _warnNotImplemented("AudioClip.pause");
    }

    play() {
        _warnNotImplemented("AudioClip.play");
    }
}

class Vector3 {
    static get down() { return new Vector3(0, -1, 0); }
    static get left() { return new Vector3(-1, 0, 0); }
    static get right() { return new Vector3(1, 0, 0); }
    static get up() { return new Vector3(0, 1, 0); }
    static get back() { return new Vector3(0, 0, -1); }
    static get forward() { return new Vector3(0, 0, 1); }
    static get zero() { return new Vector3(0, 0, 0); }

    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    equals(other) {
        return this.x === other.x &&
            this.y === other.y &&
            this.z === other.z;
    }

    add(other) {
        this.x += other.x;
        this.y += other.y;
        this.z += other.z;
        return this;
    }

    sub(other) {
        this.x -= other.x;
        this.y -= other.y;
        this.z -= other.z;
        return this;
    }

    scale(scalar) {
        this.x *= scalar;
        this.y *= scalar;
        this.z *= scalar;
        return this;
    }

    cross(other) {
        let x = this.x,
            y = this.y,
            z = this.z;

        this.x = y * other.z - z * other.y;
        this.y = z * other.x - x * other.z;
        this.z = x * other.y - y * other.x;

        return this;
    }

    dot(other) {
        return this.x * other.x + this.y * other.y + this.z * other.z;
    }

    distanceTo(other) {
        var dx = this.x - other.x;
        var dy = this.y - other.y;
        var dz = this.z - other.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    inspect( /* depth, opts */ ) {
        return this.toString();
    }

    toString() {
        return "Vector3(" + this.x + "," + this.y + "," + this.z + ")";
    }

    static add(lhs, rhs) {
        return new Vector3(lhs.x, lhs.y, lhs.z).add(rhs);
    }

    static sub(lhs, rhs) {
        return new Vector3(lhs.x, lhs.y, lhs.z).sub(rhs);
    }

    static scale(lhs, rhs) {
        return new Vector3(lhs.x, lhs.y, lhs.z).scale(rhs);
    }

    static cross(lhs, rhs) {
        return new Vector3(lhs.x, lhs.y, lhs.z).cross(rhs);
    }

    static dot(lhs, rhs) {
        return lhs.dot(rhs);
    }

    static distance(lhs, rhs) {
        return lhs.distance(rhs);
    }
}

class CollisionList {
    constructor( /* maxSize = 32 */ ) {
        this.length = 0;
    }
}

class Ray {
    constructor(origin, direction) {
        this.origin = origin;
        this.direction = direction;
    }

    cast(maxDistance) {
        return Ray.cast(this.origin, this.direction, maxDistance);
    }

    multiCast(maxDistance, results = null) {
        return Ray.multiCast(this.origin, this.direction, maxDistance, results);
    }

    static cast( /* origin, direction, maxDistance */ ) {
        _warnNotImplemented("Ray.cast");
    }

    static multiCast(origin, direction, maxDistance, results = null) {
        _warnNotImplemented("Ray.multiCast");
        if (results) {
            return 0;
        } else {
            return null;
        }
    }
}

class _DelegateVector3 extends Vector3 {
    constructor(cheerioElement) {
        super();
        ['x', 'y', 'z'].forEach(prop => {
            Object.defineProperty(this, prop, {
                get: () => parseFloat(cheerioElement.attr(prop)) || 0,
                set: val => cheerioElement.attr(prop, val),
                enumerable: true,
            });
        });
    }
}

class _RotationVector3 extends Vector3 {
    constructor(cheerioElement) {
        super();

        var rotationMap = {
            x: 'rotationX',
            y: 'rotation',
            z: 'rotationZ'
        };
        Object.keys(rotationMap).forEach(xyz => {
            var prop = rotationMap[xyz];
            Object.defineProperty(this, xyz, {
                get: () => parseFloat(cheerioElement.attr(prop)) || 0,
                set: val => cheerioElement.attr(prop, val),
                enumerable: true,
            });
        });
    }
}

function _attrProp(cheerioElement, name) {
    return {
        get: () => cheerioElement.attr(name),
        enumerable: true,
    };
}

function _propProp(node, name) {
    return {
        get: () => node[name],
        enumerable: true,
    };
}

function _nodeProp($, node, name) {
    return {
        get: () => VMElement.from($, node[name]),
        enumerable: true,
    };
}

function _vectProp(delegateVector) {
    return {
        get: () => delegateVector,
        set: newVector => {
            delegateVector.x = newVector.x;
            delegateVector.y = newVector.y;
            delegateVector.z = newVector.z;
        },
        enumerable: true,
    };
}


class VMElement extends EventEmitter {
    constructor($, node) {
        super();

        // declare props programmatically to avoid leaking
        //  and ensure read-only-ness
        var cheerioElement = $(node);
        var delegatePosition = new _DelegateVector3(cheerioElement);
        var delegateRotation = new _RotationVector3(cheerioElement);
        var toElements = (el, i) => {
            if (typeof(el) === 'number') {
                el = i;
            }
            return VMElement.from($, el);
        };

        let propsDef = {
            // special props
            position: _vectProp(delegatePosition),
            rotation: _vectProp(delegateRotation),

            // props everyone has:
            id: _attrProp(cheerioElement, 'id'),
        };

        // prepare any node-specific attributes
        var attribs = NODE_ATTRIBS[node.tagName];
        if (attribs) {
            attribs.forEach(attr => {
                propsDef[attr] = _attrProp(cheerioElement, attr);
            });
        }

        // node-specific prop defs
        var nodePropDefs = NODE_PROPDEFS[node.tagName];
        if (nodePropDefs) {
            Object.keys(nodePropDefs).forEach(prop => {
                var def = nodePropDefs[prop];
                if (typeof(def) === 'function') {
                    this[prop] = def;
                } else {
                    propsDef[prop] = def;
                }
            });
        }

        ['tagName', 'nodeValue'].forEach(prop => {
            propsDef[prop] = _propProp(node, prop);
        });

        ['parentNode', 'previousSibling', 'nextSibling',
            'firstChild', 'lastChild'
        ].forEach(nodeProp => {
            propsDef[nodeProp] = _nodeProp($, node, nodeProp);
        });

        propsDef.childNodes = {
            get: () => node.childNodes.map(toElements)
        };

        // define prepared props:
        Object.defineProperties(this, propsDef);

        // define functions:
        this.appendChild = (child) => {
            var childCheerio = ElementToCheerio.get(child);
            if (childCheerio.parentNode) {
                throw new Error(child + ' already has a parent!');
            }

            cheerioElement.append(childCheerio);
        };

        this.removeChild = (child) => {
            var childCheerio = ElementToCheerio.get(child);
            var index = cheerioElement.children().index(childCheerio);
            if (index === -1) {
                return;
            }

            cheerioElement.children()
                .eq(index) // select the index'th child
                .remove(); // remove it
        };

        this.replaceChild = (oldChild, newChild) => {
            var oldChildCheerio = ElementToCheerio.get(oldChild);
            var index = cheerioElement.children().index(oldChildCheerio);
            if (index !== -1) {
                this.replaceChildAt(index, newChild);
                return true;
            }
        };

        this.replaceChildAt = (index, newChild) => {
            var kids = cheerioElement.children();
            if (index >= 0 && index < kids.length) {
                kids.eq(index).replaceWith(ElementToCheerio.get(newChild));
            }
        };

        this.getElementById = id => {
            return cheerioElement.find('#' + id).map(toElements)[0];
        };
        this.getElementsByTagName = tag => {
            return cheerioElement.find(tag).map(toElements);
        };
        this.getElementsByClassName = className => {
            return cheerioElement.find('.' + className).map(toElements);
        };
    }

    inspect( /* depth, opts */ ) {
        return this.toString();
    }

    toString() {
        var id = this.id ? `id="${this.id}" ` : '';
        return `<${this.tagName} ${id}... />`;
    }

    static from($, cheerioElement) {
        if (!cheerioElement) return null;
        if (cheerioElement.__vmElement) return cheerioElement.__vmElement;

        var newElement = new VMElement($, cheerioElement);

        cheerioElement.__vmElement = newElement;
        ElementToCheerio.set(newElement, cheerioElement);
        return newElement;
    }
}

class VMDocument {
    constructor(iml) {
        DocumentTo$[this] = cheerio.load(iml, { xmlMode: true });
    }

    get body() {
        return this._query('body')[0];
    }

    createElementFromString(imlString) {
        var $ = cheerio.load(imlString, { xmlMode: true });
        var el = $.root().children()[0];
        return VMElement.from(getDocument$(this), el);
    }

    getElementById(id) {
        return this._query('#' + id)[0];
    }

    getElementsByClassName(className) {
        return this._query('.' + className);
    }

    getElementsByTagName(tag) {
        return this._query(tag);
    }

    _query(query) {
        let $ = getDocument$(this);
        return $(query)
            .map((i, el) => VMElement.from($, el))
            .get();
    }
}

class VMWindow {
    constructor(room, staticPath) {
        this._location = roomValidator.pathToPlanetFromRoom(room, staticPath);
    }

    get location() {
        return this._location;
    }

    requestAnimationFrame(callback) {
        setTimeout(() => {
            callback(Date.now());
        }, 16);
    }
}

module.exports = {
    AudioClip,
    CollisionList,
    Ray,
    Vector3,
    VMWindow,
    VMDocument,
    getDocument$,
};