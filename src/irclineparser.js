module.exports = parseIrcLine;
/**
 * The regex that parses a line of data from the IRCd
 * Deviates from the RFC a little to support the '/' character now used in some
 * IRCds
 */
var parse_regex = /^(?:@([^ ]+) )?(?::((?:(?:([^\s!@]+)(?:!([^\s@]+))?)@)?(\S+)) )?((?:[a-zA-Z]+)|(?:[0-9]{3}))(?: ([^:].*?))?(?: :(.*))?$/i;

function parseIrcLine(line) {
    var msg;
    var tags = Object.create(null);
    var msg_obj;

    // Parse the complete line, removing any carriage returns
    msg = parse_regex.exec(line.replace(/^\r+|\r+$/, ''));

    if (!msg) {
        // The line was not parsed correctly, must be malformed
        return;
    }

    // Extract any tags (msg[1])
    if (msg[1]) {
        msg[1].split(';').forEach(function(tag) {
            var parts = tag.split('=');
            tags[parts[0].toLowerCase()] = typeof parts[1] === 'undefined' ?
                true :
                parts[1];
        });
    }

    // Nick value will be in the prefix slot if a full user mask is not used
    msg_obj = {
        tags:       tags,
        prefix:     msg[2],
        nick:       msg[3] || msg[2],
        ident:      msg[4] || '',
        hostname:   msg[5] || '',
        command:    msg[6],
        params:     msg[7] ? msg[7].split(/ +/) : []
    };

    // Add the trailing param to the params list
    if (typeof msg[8] !== 'undefined') {
        msg_obj.params.push(msg[8].trimRight());
    }

    return msg_obj;
}
