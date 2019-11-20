/* ------------------------------------------------------------------
* node-linking - switchbot-device.js
*
* Copyright (c) 2019, Futomi Hatano, All rights reserved.
* Released under the MIT license
* Date: 2019-11-20
* ---------------------------------------------------------------- */
'use strict';
const parameterChecker = require('./parameter-checker.js');
const switchbotAdvertising = require('./switchbot-advertising.js');

class SwitchbotDevice {
  /* ------------------------------------------------------------------
  * Constructor
  *	
  * [Arguments]
  * - peripheral | Object | Required | The `peripheral` object of noble,
  *              |        |          | which represents this device
  * ---------------------------------------------------------------- */
  constructor(peripheral) {
    this._peripheral = peripheral;
    this._chars = null;

    this._SERV_UUID_PRIMARY = 'cba20d00224d11e69fb80002a5d5c51b';
    this._CHAR_UUID_WRITE = 'cba20002224d11e69fb80002a5d5c51b';
    this._CHAR_UUID_NOTIFY = 'cba20003224d11e69fb80002a5d5c51b';
    this._CHAR_UUID_DEVICE = '2a00';

    this._READ_TIMEOUT_MSEC = 3000;
    this._WRITE_TIMEOUT_MSEC = 3000;
    this._COMMAND_TIMEOUT_MSEC = 3000;

    // Save the device information
    let ad = switchbotAdvertising.parse(peripheral);
    this._id = ad.id;
    this._address = ad.address;
    this._model = ad.serviceData.model;
    this._modelName = ad.serviceData.modelName;

    this._was_connected_explicitly = false;

    this._onconnect = () => { };
    this._ondisconnect = () => { };
    this._ondisconnect_internal = () => { };
    this._onnotify_internal = () => { };
  }

  // Getters
  get id() {
    return this._id;
  }
  get address() {
    return this._address;
  }
  get model() {
    return this._model;
  }
  get modelName() {
    return this._modelName;
  }
  get connectionState() {
    return this._peripheral.state;
  }

  // Setters
  set onconnect(func) {
    if (!func || typeof (func) !== 'function') {
      throw new Error('The `onconnect` must be a function.');
    }
    this._onconnect = func;
  }
  set ondisconnect(func) {
    if (!func || typeof (func) !== 'function') {
      throw new Error('The `ondisconnect` must be a function.');
    }
    this._ondisconnect = func;
  }

  /* ------------------------------------------------------------------
  * connect()
  * - Connect the device
  *
  * [Arguments]
  * -  none
  *
  * [Returen value]
  * - Promise object
  *   Nothing will be passed to the `resolve()`.
  * ---------------------------------------------------------------- */
  connect() {
    this._was_connected_explicitly = true;
    return this._connect();
  }

  _connect() {
    return new Promise((resolve, reject) => {
      // Check the connection state
      let state = this.connectionState;
      if (state === 'connected') {
        resolve();
        return;
      } else if (state === 'connecting' || state === 'disconnecting') {
        reject(new Error('Now ' + state + '. Wait for a few seconds then try again.'));
        return;
      }

      // Set event handlers for events fired on the `Peripheral` object
      this._peripheral.once('connect', () => {
        this._onconnect();
      });
      this._peripheral.once('disconnect', () => {
        this._chars = null;
        this._peripheral.removeAllListeners();
        this._ondisconnect_internal();
        this._ondisconnect();
      });

      // Connect
      this._peripheral.connect((error) => {
        if (error) {
          reject(error);
          return;
        }
        this._discoverCharacteristics().then((chars) => {
          this._chars = chars;
          return this._subscribe();
        }).then(() => {
          resolve();
        }).catch((error) => {
          this._peripheral.disconnect();
          reject(error);
        });
      });
    });
  }

  _discoverCharacteristics() {
    return new Promise((resolve, reject) => {
      // Set timeout timer
      let timer = setTimeout(() => {
        this._ondisconnect_internal = () => { };
        this._peripheral.disconnect();
        reject(new Error('Failed to discover services and characteristics: TIMEOUT'));
      }, 5000);

      // Watch the connection state
      this._ondisconnect_internal = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        reject(new Error('Failed to discover services and characteristics: DISCONNECTED'));
      };

      // Discover services and characteristics
      this._peripheral.discoverAllServicesAndCharacteristics((error, services, chars) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this._ondisconnect_internal = () => { };

        if (error) {
          reject(error);
          return;
        }

        // Check the primary service UUID
        let service = null;
        services.forEach((s) => {
          if (s.uuid === this._SERV_UUID_PRIMARY) {
            service = s;
          }
        });
        if (!service) {
          reject(new Error('No service was found'));
          return;
        }

        // Check the characteristics
        let char_write = null;
        let char_notify = null;
        let char_device = null;

        chars.forEach((c) => {
          if (c.uuid === this._CHAR_UUID_WRITE) {
            char_write = c;
          } else if (c.uuid === this._CHAR_UUID_NOTIFY) {
            char_notify = c;
          } else if (c.uuid === this._CHAR_UUID_DEVICE) {
            char_device = c;
          }
        });
        if (!(char_write && char_notify && char_device)) {
          reject(new Error('No characteristic was found'));
          return;
        }

        resolve({
          write: char_write,
          notify: char_notify,
          device: char_device
        });
      });
    });
  }

  _subscribe() {
    return new Promise((resolve, reject) => {
      let char = this._chars.notify;
      if (!char) {
        reject(new Error('No notify characteristic was found.'));
        return;
      }
      char.subscribe((error) => {
        if (error) {
          reject(error);
          return;
        }
        char.on('data', (buf) => {
          this._onnotify_internal(buf);
        });
        resolve();
      })
    });
  }

  _unsubscribe() {
    return new Promise((resolve) => {
      let char = this._chars.notify;
      if (!char) {
        resolve();
        return;
      }
      char.removeAllListeners();
      char.unsubscribe(() => {
        resolve();
      });
    });
  }

  /* ------------------------------------------------------------------
  * disconnect()
  * - Disconnect the device
  *
  * [Arguments]
  * -  none
  *
  * [Returen value]
  * - Promise object
  *   Nothing will be passed to the `resolve()`.
  * ---------------------------------------------------------------- */
  disconnect() {
    return new Promise((resolve, reject) => {
      this._was_connected_explicitly = false;
      // Check the connection state
      let state = this._peripheral.state;
      if (state === 'disconnected') {
        resolve();
        return;
      } else if (state === 'connecting' || state === 'disconnecting') {
        reject(new Error('Now ' + state + '. Wait for a few seconds then try again.'));
        return;
      }

      // Unsubscribe
      this._unsubscribe().then(() => {
        // Disconnect
        this._peripheral.disconnect(() => {
          resolve();
        });
      });
    });
  }

  _disconnect() {
    if (this._was_connected_explicitly) {
      return new Promise((resolve, reject) => {
        resolve();
      });
    } else {
      return this.disconnect();
    }
  }

  /* ------------------------------------------------------------------
  * getDeviceName()
  * - Retrieve the device name
  *
  * [Arguments]
  * -  none
  *
  * [Returen value]
  * - Promise object
  *   The device name will be passed to the `resolve()`.
  * ---------------------------------------------------------------- */
  getDeviceName() {
    return new Promise((resolve, reject) => {
      let name = '';
      this._connect().then(() => {
        return this._read(this._chars.device);
      }).then((buf) => {
        name = buf.toString('utf8');
        return this._disconnect();
      }).then(() => {
        resolve(name);
      }).catch((error) => {
        reject(error);
      });
    });
  }

  /* ------------------------------------------------------------------
  * setDeviceName(name)
  * - Set the device name
  *
  * [Arguments]
  * - name | String | Required | Device name. The bytes length of the name
  *        |        |          | must be in the range of 1 to 20 bytes.
  *
  * [Returen value]
  * - Promise object
  *   Nothing will be passed to the `resolve()`.
  * ---------------------------------------------------------------- */
  setDeviceName(name) {
    return new Promise((resolve, reject) => {
      // Check the parameters
      let valid = parameterChecker.check({ name: name }, {
        name: { required: true, type: 'string', minBytes: 1, maxBytes: 100 }
      });

      if (!valid) {
        reject(new Error(parameterChecker.error.message));
        return;
      }

      let buf = Buffer.from(name, 'utf8');
      this._connect().then(() => {
        return this._write(this._chars.device, buf);
      }).then(() => {
        return this._disconnect();
      }).then(() => {
        resolve();
      }).catch((error) => {
        reject(error);
      });
    });
  }

  // Write the specified Buffer data to the write characteristic
  // and receive the response from the notify characteristic
  // with connection handling
  _command(req_buf) {
    return new Promise((resolve, reject) => {
      if (!Buffer.isBuffer(req_buf)) {
        reject(new Error('The specified data is not acceptable for writing.'));
        return;
      }

      let res_buf = null;

      this._connect().then(() => {
        return this._write(this._chars.write, req_buf);
      }).then(() => {
        return this._waitCommandResponse();
      }).then((buf) => {
        res_buf = buf;
        return this._disconnect();
      }).then(() => {
        resolve(res_buf);
      }).catch((error) => {
        reject(error);
      });
    });
  }

  _waitCommandResponse() {
    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        timer = null;
        this._onnotify_internal = () => { };
        reject(new Error('COMMAND_TIMEOUT'));
      }, this._COMMAND_TIMEOUT_MSEC);

      this._onnotify_internal = (buf) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this._onnotify_internal = () => { };
        resolve(buf);
      };
    });
  }

  // Read data from the specified characteristic
  _read(char) {
    return new Promise((resolve, reject) => {
      // Set a timeout timer
      let timer = setTimeout(() => {
        reject('READ_TIMEOUT');
      }, this._READ_TIMEOUT_MSEC);

      // Read charcteristic data
      char.read((error, buf) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (error) {
          reject(error);
        } else {
          resolve(buf);
        }
      });
    });
  }

  // Write the specified Buffer data to the specified characteristic
  _write(char, buf) {
    return new Promise((resolve, reject) => {
      // Set a timeout timer
      let timer = setTimeout(() => {
        reject('WRITE_TIMEOUT');
      }, this._WRITE_TIMEOUT_MSEC);

      // write charcteristic data
      char.write(buf, false, (error) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

}

module.exports = SwitchbotDevice;