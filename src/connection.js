'use strict';

const _ = {
    pull: require('lodash/pull'),
};
const EventEmitter = require('eventemitter3');
const ircLineParser = require('./irclineparser');
var iconv           = require('iconv-lite');
var isValidUTF8     = require('utf-8-validate');

module.exports = class Connection extends EventEmitter {
    constructor(options) {
        super();

        this.options = options || {};

        this.connected = false;
        this.requested_disconnect = false;

        this.reconnect_attempts = 0;

        // When an IRC connection was successfully registered.
        this.registered = false;

        this.transport = null;

        this.encoding = 'utf8';
        this.encoding_fallback = '';

        this._timers = [];
    }

    debugOut(out) {
        this.emit('debug', out);
    }

    registeredSuccessfully() {
        this.registered = Date.now();
    }

    connect(options) {
        const that = this;

        if (options) {
            this.options = options;
        }
        options = this.options;

        this.auto_reconnect = options.auto_reconnect || false;
        this.auto_reconnect_max_retries = options.auto_reconnect_max_retries || 3;
        this.auto_reconnect_max_wait = options.auto_reconnect_max_wait || 300000;

        if (this.transport) {
            this.clearTimers();
            this.transport.removeAllListeners();
            this.transport.disposeSocket();
        }
        this.transport = new options.transport(options);

        if (!options.encoding || !this.setEncoding(options.encoding)) {
            this.setEncoding('utf8');
        }

        if (!options.encoding_fallback || !this.setEncodingFallback(options.encoding_fallback)) {
            this.setEncodingFallback('');
        }

        // Some transports may emit extra events
        this.transport.on('extra', function(/*event_name, argN*/) {
            that.emit.apply(that, arguments);
        });

        bindTransportEvents(this.transport);

        this.registered = false;
        this.requested_disconnect = false;
        this.emit('connecting');
        this.transport.connect();

        function bindTransportEvents(transport) {
            transport.on('open', socketOpen);
            transport.on('line', socketLine);
            transport.on('close', socketClose);
            transport.on('debug', transportDebug);
            transport.on('extra', transportExtra);
        }

        function transportDebug(out) {
            that.debugOut(out);
        }

        function transportExtra() {
            // Some transports may emit extra events
            that.emit.apply(that, arguments);
        }

        // Called when the socket is connected and ready to start sending/receiving data.
        function socketOpen() {
            that.debugOut('Socket fully connected');
            that.reconnect_attempts = 0;
            that.connected = true;
            that.emit('socket connected');
        }

        function socketLine(line) {
            that.addReadBuffer(line);
        }

        function socketClose(err) {
            const was_connected = that.connected;
            let should_reconnect = false;
            let safely_registered = false;
            const registered_ms_ago = Date.now() - that.registered;

            // Some networks use aKills which kill a user after succesfully
            // registering instead of a ban, so we must wait some time after
            // being registered to be sure that we are connected properly.
            safely_registered = that.registered !== false && registered_ms_ago > 5000;

            that.debugOut('Socket closed. was_connected=' + was_connected + ' safely_registered=' + safely_registered + ' requested_disconnect=' + that.requested_disconnect);

            that.connected = false;
            that.clearTimers();

            that.emit('socket close', err);

            if (that.requested_disconnect || !that.auto_reconnect) {
                should_reconnect = false;

            // If trying to reconnect, continue with it
            } else if (that.reconnect_attempts && that.reconnect_attempts < that.auto_reconnect_max_retries) {
                should_reconnect = true;

            // If we were originally connected OK, reconnect
            } else if (was_connected && safely_registered) {
                should_reconnect = true;
            } else {
                should_reconnect = false;
            }

            if (should_reconnect) {
                const reconnect_wait = that.calculateExponentialBackoff();

                that.reconnect_attempts++;
                that.emit('reconnecting', {
                    attempt: that.reconnect_attempts,
                    max_retries: that.auto_reconnect_max_retries,
                    wait: reconnect_wait
                });

                that.debugOut('Scheduling reconnect. Attempt: ' + that.reconnect_attempts + '/' + that.auto_reconnect_max_retries + ' Wait: ' + reconnect_wait + 'ms');
                that.setTimeout(() => that.connect(), reconnect_wait);
            } else {
                that.transport.removeAllListeners();
                that.emit('close', !!err);
                that.reconnect_attempts = 0;
            }
        }
    }

    calculateExponentialBackoff() {
        const jitter = 1000 + Math.floor(Math.random() * 5000);
        const attempts = Math.min(this.reconnect_attempts, 30);
        const time = 1000 * Math.pow(2, attempts);
        return Math.min(time, this.auto_reconnect_max_wait) + jitter;
    }

    addReadBuffer(line) {
        if (!line) {
            // Empty line
            return;
        }

        this.emit('raw', { line: line, from_server: true });

        const message = ircLineParser(line);
        if (!message) {
            // A malformed IRC line
            return;
        }

        this.emit('message', message, line);
    }

    write(data, callback) {
        if (!this.connected || this.requested_disconnect) {
            this.debugOut('write() called when not connected');

            if (callback) {
                setTimeout(callback, 0); // fire in next tick
            }

            return false;
        }

        this.emit('raw', { line: data, from_server: false });
        return this.transport.writeLine(data, callback);
    }

    /**
     * Create and keep track of all timers so they can be easily removed
     */
    setTimeout(/* fn, length, argN */) {
        const that = this;
        let tmr = null;
        const args = Array.prototype.slice.call(arguments, 0);
        const callback = args[0];

        args[0] = function() {
            _.pull(that._timers, tmr);
            callback.apply(null, args);
        };

        tmr = setTimeout.apply(null, args);
        this._timers.push(tmr);
        return tmr;
    }

    clearTimeout(tmr) {
        clearTimeout(tmr);
        _.pull(this._timers, tmr);
    }

    clearTimers() {
        this._timers.forEach(function(tmr) {
            clearTimeout(tmr);
        });

        this._timers = [];
    }

    /**
     * Close the connection to the IRCd after forcing one last line
     */
    end(data, had_error) {
        const that = this;

        this.debugOut('Connection.end() connected=' + this.connected + ' with data=' + !!data + ' had_error=' + !!had_error);

        if (this.connected && data) {
            // Once the last bit of data has been sent, then re-run this function to close the socket
            this.write(data, function() {
                that.end(null, had_error);
            });

            return;
        }

        // Shutdowns of the connection may be caused by errors like ping timeouts, which
        // are not requested by the user so we leave requested_disconnect as false to make sure any
        // reconnects happen.
        if (!had_error) {
            this.requested_disconnect = true;
            this.clearTimers();
        }

        if (this.transport) {
            this.transport.close(!!had_error);
        }
    }

    setEncoding(encoding) {
        this.debugOut('Connection.setEncoding() encoding=' + encoding);

        if (this.testEncoding(encoding)) {
            this.encoding = encoding;

            if (this.transport) {
                this.transport.setEncoding(encoding);
            }
            return true;
        }
        return false;
    }

    setEncodingFallback(encoding) {
        this.debugOut('Connection.setEncodingFallback() encoding=' + encoding);

        if (!encoding) {
            this.encoding_fallback = '';
            return true;
        } else if (this.testEncoding(encoding)) {
            this.encoding_fallback = encoding;
            return true;
        } else {
            return false;
        }
    }

    testEncoding(encoding) {
        try {
            const encoded_test = iconv.encode('TEST', encoding);
            // This test is done to check if this encoding also supports
            // the ASCII charset required by the IRC protocols
            // (Avoid the use of base64 or incompatible encodings)
            if (encoded_test == 'TEST') { // jshint ignore:line
                return true;
            }
            return false;
        } catch (err) {
            return false;
        }
    }

    /**
     * Process the buffered messages recieved from the IRCd
     * Will only process 4 lines per JS tick so that node can handle any other events while
     * handling a large buffer
     */
    processReadBuffer(continue_processing) {
        // If we already have the read buffer being iterated through, don't start
        // another one.
        if (this.reading_buffer && !continue_processing) {
            return;
        }

        var that = this;
        var lines_per_js_tick = 40;
        var processed_lines = 0;
        var line;
        var message;

        this.reading_buffer = true;

        while (processed_lines < lines_per_js_tick && this.read_buffer.length > 0) {
            line = this.read_buffer.shift();
            if (!line) {
                continue;
            }

            message = this.parseLine(line);

            if (!message) {
                // A malformed IRC line
                continue;
            }
            this.emit('raw', { line: line, from_server: true });
            this.emit('message', message, line);

            processed_lines++;
        }

        // If we still have items left in our buffer then continue reading them in a few ticks
        if (this.read_buffer.length > 0) {
            this.setTimeout(function() {
                that.processReadBuffer(true);
            }, 1);
        } else {
            this.reading_buffer = false;
        }
    }

    parseLine(line) {
        if (typeof line === 'string') {
            return ircLineParser(line);
        } else {
            const line_bytes = line;
            line = iconv.decode(line_bytes, this.encoding);
            var message = ircLineParser(line);

            // If fallback is necessary, fill the params with re-decoded message
            if (this.encoding === 'utf8' && this.encoding_fallback && !isValidUTF8(line_bytes)) {
                const line_fallback = iconv.decode(line_bytes, this.encoding_fallback);
                const message_fallback = ircLineParser(line_fallback);

                if (message.params.length == message_fallback.params.length) {
                    message.params = message_fallback.params;
                }
            }

            return message;
        }
    }
};
