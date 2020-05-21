'use strict';

const defaultsDeep = require('lodash/defaultsDeep');
const uniq = require('lodash/uniq');

const PLAIN_TYPES = ['string', 'number', 'boolean'];
const ARRAY_TYPES = [
  'Array',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array'
];
const DOC_DB_TYPES = ['JSON', 'JSONB', 'HSTORE'];

function _padWith0 (v) {
  v = '' + v;
  return v.length === 1 ? '0' + v : v;
}

function encodeToJSON (value, options) {
  const className =
    value && typeof value.constructor === 'function'
      ? value.constructor.name
      : null;

  if (PLAIN_TYPES.indexOf(typeof value) > -1 || value === null) {
    return value;
  } else if (ARRAY_TYPES.indexOf(className) > -1) {
    const result = [];
    for (const e of value) {
      result.push(encodeToJSON(e, options));
    }

    return result;
  } else if (value instanceof Date) {
    return value.toISOString();
  } else if (value instanceof Buffer) {
    return value.toString(options.blobEncoding);
  } else if (typeof value === 'object') {
    const result = {};
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        result[key] = encodeToJSON(value[key], options);
      }
    }

    return result;
  } else {
    throw new Error("Can't encode " + typeof value + ' to JSON');
  }
}

const _policies = { FAIL: 1, SKIP: 2, SET_NULL: 3 };

const _defaultOptions = {
  encoder: encodeToJSON,
  undefinedPolicy: _policies.SKIP,
  copyJSONFields: true,
  simpleDates: true,
  encoderOptions: {
    blobEncoding: 'base64'
  }
};

function _getSchemeFromModel (model, scheme) {
  if (model.serializer && model.serializer.schemes) {
    return model.serializer.schemes[scheme] || null;
  }

  return null;
}

function _isModel (obj, sequelize, seqVer) {
  if (seqVer >= 4) {
    return obj.prototype instanceof sequelize.Model;
  } else {
    return obj instanceof sequelize.Model;
  }
}

function _isModelInstance (obj, sequelize, seqVer) {
  if (seqVer >= 4) {
    return obj instanceof sequelize.Model;
  } else {
    return obj instanceof sequelize.Instance;
  }
}
function _getModelFromInstance (inst, seqVer) {
  if (seqVer >= 4) {
    return inst.constructor;
  } else {
    return inst.Model;
  }
}

function _isSpecificModelInstance (obj, model, seqVer) {
  if (seqVer >= 4) {
    return obj instanceof model;
  } else {
    return obj instanceof model.Instance;
  }
}

class Serializer {
  constructor (model, scheme, options) {
    const sequelize = model.sequelize || {};
    const seqVer = 1 * (sequelize.constructor.version || '-').split('.', 2)[0]; // major version as number
    let schemeName = null;

    if (
      !sequelize.Model ||
      isNaN(seqVer) ||
      !_isModel(model, sequelize, seqVer)
    ) {
      throw new Error('' + model + ' is not a valid Sequelize model');
    }

    if (typeof scheme === 'string') {
      schemeName = scheme;
      scheme = _getSchemeFromModel(model, scheme);
    } else if (!scheme) {
      if (model.serializer) {
        const schemes = model.serializer.schemes || {};

        if (model.serializer.defaultScheme) {
          schemeName = model.serializer.defaultScheme;
          scheme = schemes[model.serializer.defaultScheme];
        } else {
          if (schemes.default) {
            schemeName = 'default';
            scheme = schemes.default;
          } else {
            scheme = {};
          }
        }
      } else {
        scheme = {};
      }
    }

    if (!scheme || typeof scheme !== 'object') {
      throw new Error(
        'Invalid serialization scheme for ' + model.name + ': ' + scheme
      );
    }

    this._origOptions = options;
    this._options = defaultsDeep(
      {},
      options,
      scheme.options,
      model.serializer ? model.serializer.options : null,
      _defaultOptions
    );

    this._seq = sequelize;
    this._seqVer = seqVer;
    this._model = model;
    this._scheme = scheme;
    this._schemeName = schemeName;

    this._attr = {
      all: [],
      virtual: [],
      pk: [],
      fk: [],
      assoc: [],
      blob: [],
      doc: [],
      auto: []
    };

    this._collectAttrs();
    this._attrList = this._compileAttributesList(scheme);
  }

  _collectAttrs () {
    const attr = this._attr;
    let a, typeName;

    const rawAttributes = this._model.attributes || this._model.rawAttributes;

    for (const name in rawAttributes) {
      if (!Object.prototype.hasOwnProperty.call(rawAttributes, name)) continue;

      a = rawAttributes[name];

      if (
        this._options.attrFilter &&
        this._options.attrFilter(a, this._model) === false
      ) {
        continue;
      }

      typeName = a.type.key;

      attr.all.push(a.fieldName);

      if (a.primaryKey) attr.pk.push(a.fieldName);
      if (a.references) attr.fk.push(a.fieldName);
      if (a._autoGenerated) attr.auto.push(a.fieldName);

      if (typeName === 'VIRTUAL') attr.virtual.push(a.fieldName);
      else if (typeName === 'BLOB') attr.blob.push(a.fieldName);
      else if (DOC_DB_TYPES.indexOf(typeName) > -1) attr.doc.push(a.fieldName);
    }

    for (const name in this._model.associations) {
      // if(!this._model.attributes.hasOwnProperty(name)) continue;
      a = this._model.associations[name];
      attr.assoc.push(a.as);
    }
  }

  _expandAttributes (list) {
    const attr = this._attr;
    let result = [];

    for (const a of list) {
      if (a[0] === '@') {
        result = result.concat(result, attr[a.substr(1)]);
      } else {
        result.push(a);
      }
    }

    return uniq(result);
  }

  _compileAttributesList (scheme) {
    const include = scheme.include
      ? this._expandAttributes(scheme.include)
      : this._attr.all;
    const exclude = scheme.exclude
      ? this._expandAttributes(scheme.exclude)
      : [];
    const result = [];

    for (const a of include) {
      if (exclude.indexOf(a) < 0) {
        result.push(
          a[0] !== '.' &&
            this._attr.all.indexOf(a) < 0 &&
            this._attr.assoc.indexOf(a) < 0
            ? '.' + a
            : a
        );
      }
    }

    return result;
  }

  _serializeValue (attr, value, cache) {
    const a = this._model.attributes[attr];
    let returnJSON = false;

    if (a && this._options.copyJSONFields) {
      returnJSON =
        a.type instanceof this._seq.Sequelize.JSON ||
        a.type instanceof this._seq.Sequelize.JSONB;
    }

    if (returnJSON) {
      return value;
    } else if (value instanceof Array) {
      const result = [];
      for (const e of value) {
        result.push(this._serializeValue(attr, e, cache));
      }
      return result;
    } else if (_isModelInstance(value, this._seq, this._seqVer)) {
      return this._serializeAssoc(attr, value, cache);
    } else {
      if (
        this._options.simpleDates &&
        a &&
        a.type instanceof this._seq.Sequelize.DATEONLY &&
        value instanceof Date
      ) {
        value =
          value.getFullYear() +
          '-' +
          _padWith0(value.getMonth() + 1) +
          '-' +
          _padWith0(value.getDate());
      }

      return this._options.encoder(value, this._options.encoderOptions);
    }
  }

  _serializeAssoc (attr, inst, cache) {
    const attrPath = (this._attrPath ? this._attrPath + '.' : '') + attr;
    let serializer;

    if (cache && cache[attrPath]) {
      serializer = cache[attrPath];
    } else {
      const scheme = this._scheme.assoc ? this._scheme.assoc[attr] : null;

      serializer = new Serializer(
        _getModelFromInstance(inst, this._seqVer),
        scheme,
        this._origOptions
      );
      serializer._attrPath = attrPath;

      if (cache) cache[attrPath] = serializer;
    }

    return serializer.serialize(inst, cache);
  }

  serialize (inst, cache) {
    if (!_isSpecificModelInstance(inst, this._model, this._seqVer)) {
      throw new Error('Not an instance of ' + this._model.name);
    }

    let output = {};
    let value;
    let name;

    for (let a of this._attrList) {
      // if the attribute name is dot-prefixed, always treat it as a regular attribute of the model instance
      if (a[0] !== '.' && this._attr.all.indexOf(a) > -1) {
        value = inst.get(a);
      } else {
        if (a[0] === '.') a = a.substr(1);

        value = inst[a];
        if (typeof value === 'function') {
          value = value.call(inst);
        }
      }

      name = (this._scheme.as ? this._scheme.as[a] : null) || a;

      if (typeof value !== 'undefined') {
        output[name] = this._serializeValue(a, value, cache);
      } else {
        switch (this._options.undefinedPolicy) {
          case _policies.SKIP:
            break;
          case _policies.SET_NULL:
            output[name] = null;
            break;
          case _policies.FAIL:
            throw new Error(
              'Undefined attribute on ' + this._model.name + ' instance: ' + a
            );
          default:
            throw new Error('Invalid undefinedPolicy setting');
        }
      }
    }

    if (this._model.serializer && this._model.serializer.postSerialize) {
      output = this._model.serializer.postSerialize.call(
        this._scheme,
        output,
        inst,
        this._schemeName
      );
    }

    if (this._scheme.postSerialize) {
      output = this._scheme.postSerialize(output, inst);
    }

    return output;
  }

  static serializeMany (data, model, scheme, options) {
    const serializer = new Serializer(model, scheme, options);
    const cache = {};
    const result = [];

    for (const inst of data) {
      result.push(serializer.serialize(inst, cache));
    }

    return result;
  }
}

for (const p in _policies) {
  Serializer[p] = _policies[p];
}

Serializer.encodeToJSON = encodeToJSON;
Serializer.defaultOptions = _defaultOptions;

module.exports = Serializer;
