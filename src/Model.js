import uuid from 'uuid-v4';
import result from 'lodash.result';
import pickBy from 'lodash.pickby';
import pick from 'lodash.pick';
import omit from 'lodash.omit';
import forIn from 'lodash.forin';
import { observable, action, runInAction } from 'mobx';
import request from 'axios';

// Throw an error when a URL is needed, and none is supplied.
const urlError = () => {
  throw new Error('A url" property or function must be specified');
};

class Model {
  @observable fetching;
  @observable saving;
  @observable deleting;

  get idAttribute() {
    return 'id';
  }

  constructor(data = {}, options) {
    // Merge in the any options with the default
    options = Object.assign(
      {
        parse: true,
        stripUndefined: true,
        stripNonRest: true
      },
      options
    );

    this.uuid = uuid();
    this.fetching = false;
    this.saving = false;
    this.deleting = false;
    this.attributes = observable.map({});
    this.defineProperties();

    this.applyOptions(options);

    data = this.setRestAttributeDefaults(data);

    this.set(data, options);
  }

  /**
   * Apply options to the Model
   */
  applyOptions(options) {
    if (options.collection) {
      this.collection = options.collection;
    }

    if (options.parent) {
      this.parent = options.parent;
    }

    if (options.rootStore) {
      this.rootStore = options.rootStore;
    }
  }

  get restAttributes() {
    return [this.idAttribute];
  }

  /**
   * Create getters/setters for the allowed attributes
   */
  defineProperties() {
    this.restAttributes.forEach(key => {
      Object.defineProperty(this, key, {
        get: () => {
          return this.attributes.get(key);
        },
        set: value => {
          this.attributes.set(key, value);
        },
        enumerable: true,
        configurable: true
      });
    });
  }

  /**
   * The model URL
   */
  url() {
    // Get the base URL specified as urlRoot or in the collection:
    const base = this.urlRoot || result(this.collection, 'url') || urlError();

    if (this.isNew) {
      return base;
    }

    return (
      base +
      (base.charAt(base.length - 1) === '/' ? '' : '/') +
      encodeURIComponent(this.urlId)
    );
  }

  /**
   * Make is possible to override the URL id
   */
  get urlId() {
    return this.id;
  }

  /**
   * Returns the unique identifier of the model.
   * Returns either the server id or fall back to client uuid.
   */
  get uniqueId() {
    return this.id ? this.id : this.uuid;
  }

  /**
   * Getter to check if a model is yet to be saved to the server
   */
  get isNew() {
    return !this.id;
  }

  /**
   * Controls boolean value of request label
   */
  @action
  setRequestLabel(label, state = false) {
    this[label] = state;
  }

  /**
   * Sets the attributes data via merge
   */
  @action
  set(data = {}, options) {
    // Merge in the any options with the default
    options = Object.assign(
      {
        parse: true,
        stripUndefined: true,
        stripNonRest: true,
        replace: false
      },
      options
    );

    // Set the id immediately if possible
    if (data && data[this.idAttribute]) {
      this.id = data[this.idAttribute];
    }

    // Parse the data
    if (data && options.parse) {
      data = this.parse(data);
    }

    // Strip out any undefined keys.
    if (options.stripUndefined) {
      data = pickBy(data, prop => prop !== undefined);
    }

    // Strip out any keys not specificly set as rest attributes.
    if (options.stripNonRest) {
      data = this.stripNonRestAttributes(data);
    }

    if (options.replace) {
      this.attributes.replace(data);
    } else {
      this.attributes.merge(data);
    }

    return this;
  }

  /**
   * Sets any defaults for attributes required by the front-end
   * but may not always be returned by the API
   */
  @action
  setRestAttributeDefaults(data) {
    if (this.restAttributeDefaults) {
      if (data === null) {
        data = {};
      }

      forIn(this.restAttributeDefaults, (value, key) => {
        if (typeof data[key] === 'undefined') {
          data[key] = value;
        }
      });
    }

    return data;
  }

  /**
   * Strips out any non-recognized attributes when saving to/from
   * the API
   */
  @action
  stripNonRestAttributes(data) {
    forIn(data, (value, key) => {
      if (this.restAttributes.indexOf(key) === -1) {
        data = omit(data, key);
      }
    });

    return data;
  }

  /**
   * Converts a response into the hash of attributes to be `set` on the model.
   * The default implementation is just to pass the response along.
   */
  @action
  parse(attributes) {
    return attributes;
  }

  /**
   * Clears the models attributes
   */
  @action
  clear() {
    this.attributes.clear();
  }

  /**
   * Picks properties and returns them as an object.
   */
  @action
  pick(properties) {
    return pick(this.attributes, properties);
  }

  /**
   * Fetch the model from the server.
   */
  @action
  fetch(options = {}, globalOptions) {
    this.setRequestLabel('fetching', true);

    const url = options.url ? options.url : this.url();

    return new Promise((resolve, reject) => {
      request
        .get(url, {
          params: options.params ? options.params : {},
          ...globalOptions
        })
        .then(
          response => {
            runInAction('fetch-success', () => {
              this.set(this.setRestAttributeDefaults(response.data));
              this.setRequestLabel('fetching', false);
              resolve(this);
            });
          },
          error => {
            runInAction('fetch-error', () => {
              this.setRequestLabel('fetching', false);
              reject(error);
            });
          }
        );
    });
  }

  /**
   * Save the model to the server via a PATCH request.
   * If the model is new delegates to the create action.
   * If the `wait` option is false it will optimistically
   * update the data passed
   */
  @action
  save(data = null, options) {
    // Merge in the any options with the default
    options = Object.assign(
      {
        wait: false,
        stripNonRest: true,
        replace: false,
        method: 'patch'
      },
      options
    );

    // Save reference to the current atributes
    const originalAttributes = this.attributes.toJSON();

    // Strip out attributes not defined in the restAttributes map
    if (options.stripNonRest) {
      data = this.stripNonRestAttributes(data);
    }
    if (data === null) {
      data = Object.assign({}, originalAttributes);
    }

    // If the model does not have an ID. Send a POST request
    if (this.isNew) {
      return this.create(data, options);
    }

    if (options.wait) {
      this.setRequestLabel('saving', true);
    } else {
      this.set(data, options);
    }

    return new Promise((resolve, reject) => {
      request[options.method](
        options.url ? options.url : this.url(),
        data
      ).then(
        response => {
          runInAction('save-success', () => {
            this.set(Object.assign({}, data, response.data), options);
            this.setRequestLabel('saving', false);
            resolve(this);
          });
        },
        error => {
          runInAction('save-error', () => {
            if (!options.wait) {
              this.set(originalAttributes, options);
            }

            this.setRequestLabel('saving', false);
            reject(error);
          });
        }
      );
    });
  }

  /**
   * Create a new model to the server with  a POST request.
   * If the `wait` option is false it will optimistically
   * update the attributes and relationships passed in.
   */
  @action
  create(data = null, options) {
    // Merge in the any options with the default
    options = Object.assign(
      {
        wait: false,
        method: 'post',
        notAttributes: false
      },
      options
    );

    const originalAttributes = this.attributes.toJSON();

    if (data) {
      if (!options.notAttributes) {
        data = Object.assign({}, originalAttributes, data);
      }
    } else {
      data = Object.assign({}, originalAttributes);
    }

    if (!options.wait) {
      this.set(data);
    } else {
      this.setRequestLabel('saving', true);
    }

    return new Promise((resolve, reject) => {
      request.post(options.url ? options.url : this.url(), data).then(
        response => {
          runInAction('create-success', () => {
            this.set(response.data);
            this.setRequestLabel('saving', false);
            resolve(this);
          });
        },
        error => {
          runInAction('create-error', () => {
            if (!options.wait) {
              this.set(originalAttributes);
            }

            this.setRequestLabel('saving', false);
            reject(error);
          });
        }
      );
    });
  }

  /**
   * Destroy this model on the server if it was already persisted.
   * Optimistically removes the model from its collection, if it has one.
   * If `wait: true` is passed, waits for the server to respond before removal.
   */
  @action
  destroy(options) {
    // Merge in the any options with the default
    options = Object.assign(
      {
        wait: false
      },
      options
    );

    if (this.isNew && this.collection) {
      this.collection.remove(this);

      return true;
    }

    if (!options.wait && this.collection) {
      this.collection.remove(this);
    } else {
      this.setRequestLabel('deleting', true);
    }

    return new Promise((resolve, reject) => {
      request.delete(options.url ? options.url : this.url()).then(
        response => {
          runInAction('destroy-success', () => {
            if (options.wait && this.collection) {
              this.collection.remove(this);
            }
            this.setRequestLabel('deleting', false);
            resolve(this);
          });
        },
        error => {
          runInAction('destroy-error', () => {
            // Put it back if delete request fails
            if (!options.wait && this.collection) {
              if (error && error.response && error.response.status === 404)
                return;

              this.collection.add(this);
            }

            this.setRequestLabel('deleting', false);
            reject(error);
          });
        }
      );
    });
  }
}

export default Model;
