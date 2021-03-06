exports.Form = Form;

var stream = require('readable-stream')
  , util = require('util')
  , fs = require('fs')
  , crypto = require('crypto')
  , path = require('path')
  , os = require('os')
  , StringDecoder = require('string_decoder').StringDecoder
  , StreamCounter = require('stream-counter')

var START = 0
  , START_BOUNDARY = 1
  , HEADER_FIELD_START = 2
  , HEADER_FIELD = 3
  , HEADER_VALUE_START = 4
  , HEADER_VALUE = 5
  , HEADER_VALUE_ALMOST_DONE = 6
  , HEADERS_ALMOST_DONE = 7
  , PART_DATA_START = 8
  , PART_DATA = 9
  , PART_END = 10
  , CLOSE_BOUNDARY = 11
  , END = 12

  , LF = 10
  , CR = 13
  , SPACE = 32
  , HYPHEN = 45
  , COLON = 58
  , A = 97
  , Z = 122

var CONTENT_TYPE_RE = /^multipart\/(?:form-data|related)(?:;|$)/i;
var CONTENT_TYPE_PARAM_RE = /;\s*([^=]+)=(?:"([^"]+)"|([^;]+))/gi;
var FILE_EXT_RE = /(\.[_\-a-zA-Z0-9]{0,16}).*/;
var LAST_BOUNDARY_SUFFIX_LEN = 4; // --\r\n

util.inherits(Form, stream.Writable);
function Form(options) {
  var self = this;
  stream.Writable.call(self);

  options = options || {};

  self.error = null;
  self.finished = false;

  self.autoFields = !!options.autoFields;
  self.autoFiles = !!options.autoFiles;

  self.maxFields = options.maxFields || 1000;
  self.maxFieldsSize = options.maxFieldsSize || 2 * 1024 * 1024;
  self.maxFilesSize = options.maxFilesSize || Infinity;
  self.uploadDir = options.uploadDir || os.tmpDir();
  self.encoding = options.encoding || 'utf8';
  self.hash = options.hash || false;

  self.bytesReceived = 0;
  self.bytesExpected = null;

  self.openedFiles = [];
  self.totalFieldSize = 0;
  self.totalFieldCount = 0;
  self.totalFileSize = 0;
  self.flushing = 0;

  self.backpressure = false;
  self.writeCbs = [];

  if (options.boundary) setUpParser(self, options.boundary);

  self.on('newListener', function(eventName) {
    if (eventName === 'file') {
      self.autoFiles = true;
    } else if (eventName === 'field') {
      self.autoFields = true;
    }
  });
}

Form.prototype.parse = function(req, cb) {
  var self = this;

  // if the user supplies a callback, this implies autoFields and autoFiles
  if (cb) {
    self.autoFields = true;
    self.autoFiles = true;
  }

  self.handleError = handleError;
  self.bytesExpected = getBytesExpected(req.headers);

  req.on('error', handleError);
  req.on('aborted', onReqAborted);

  var contentType = req.headers['content-type'];
  if (!contentType) {
    handleError(new Error('missing content-type header'));
    return;
  }

  var m = CONTENT_TYPE_RE.exec(contentType);
  if (!m) {
    handleError(new Error('unrecognized content-type: ' + contentType));
    return;
  }

  var boundary;
  CONTENT_TYPE_PARAM_RE.lastIndex = m.index + m[0].length - 1;
  while ((m = CONTENT_TYPE_PARAM_RE.exec(contentType))) {
    if (m[1].toLowerCase() !== 'boundary') continue;
    boundary = m[2] || m[3];
    break;
  }

  if (!boundary) {
    handleError(new Error('content-type missing boundary: ' + require('util').inspect(m)));
    return;
  }

  setUpParser(self, boundary);
  req.pipe(self);

  if (cb) {
    var fields = {};
    var files = {};
    self.on('error', function(err) {
      cb(err);
    });
    self.on('field', function(name, value) {
      var fieldsArray = fields[name] || (fields[name] = []);
      fieldsArray.push(value);
    });
    self.on('file', function(name, file) {
      var filesArray = files[name] || (files[name] = []);
      filesArray.push(file);
    });
    self.on('close', function() {
      cb(null, fields, files);
    });
  }

  function onReqAborted() {
    self.emit('aborted');
    handleError(new Error("Request aborted"));
  }

  function handleError(err) {
    var first = !self.error;
    if (first) {
      self.error = err;
      req.removeListener('aborted', onReqAborted);

      // welp. 0.8 doesn't support unpipe, too bad so sad.
      // let's drop support for 0.8 soon.
      if (req.unpipe) {
        req.unpipe(self);
      }
    }

    self.openedFiles.forEach(function(file) {
      destroyFile(self, file);
    });
    self.openedFiles = [];

    if (first) {
      self.emit('error', err);
    }
  }

};

Form.prototype._write = function(buffer, encoding, cb) {
  var self = this
    , i = 0
    , len = buffer.length
    , prevIndex = self.index
    , index = self.index
    , state = self.state
    , lookbehind = self.lookbehind
    , boundary = self.boundary
    , boundaryChars = self.boundaryChars
    , boundaryLength = self.boundary.length
    , boundaryEnd = boundaryLength - 1
    , bufferLength = buffer.length
    , c
    , cl

  for (i = 0; i < len; i++) {
    c = buffer[i];
    switch (state) {
      case START:
        index = 0;
        state = START_BOUNDARY;
        /* falls through */
      case START_BOUNDARY:
        if (index === boundaryLength - 2 && c === HYPHEN) {
          index = 1;
          state = CLOSE_BOUNDARY;
          break;
        } else if (index === boundaryLength - 2) {
          if (c !== CR) return self.handleError(new Error("Expected CR Received " + c));
          index++;
          break;
        } else if (index === boundaryLength - 1) {
          if (c !== LF) return self.handleError(new Error("Expected LF Received " + c));
          index = 0;
          self.onParsePartBegin();
          state = HEADER_FIELD_START;
          break;
        }

        if (c !== boundary[index+2]) index = -2;
        if (c === boundary[index+2]) index++;
        break;
      case HEADER_FIELD_START:
        state = HEADER_FIELD;
        self.headerFieldMark = i;
        index = 0;
        /* falls through */
      case HEADER_FIELD:
        if (c === CR) {
          self.headerFieldMark = null;
          state = HEADERS_ALMOST_DONE;
          break;
        }

        index++;
        if (c === HYPHEN) break;

        if (c === COLON) {
          if (index === 1) {
            // empty header field
            self.handleError(new Error("Empty header field"));
            return;
          }
          self.onParseHeaderField(buffer.slice(self.headerFieldMark, i));
          self.headerFieldMark = null;
          state = HEADER_VALUE_START;
          break;
        }

        cl = lower(c);
        if (cl < A || cl > Z) {
          self.handleError(new Error("Expected alphabetic character, received " + c));
          return;
        }
        break;
      case HEADER_VALUE_START:
        if (c === SPACE) break;

        self.headerValueMark = i;
        state = HEADER_VALUE;
        /* falls through */
      case HEADER_VALUE:
        if (c === CR) {
          self.onParseHeaderValue(buffer.slice(self.headerValueMark, i));
          self.headerValueMark = null;
          self.onParseHeaderEnd();
          state = HEADER_VALUE_ALMOST_DONE;
        }
        break;
      case HEADER_VALUE_ALMOST_DONE:
        if (c !== LF) return self.handleError(new Error("Expected LF Received " + c));
        state = HEADER_FIELD_START;
        break;
      case HEADERS_ALMOST_DONE:
        if (c !== LF) return self.handleError(new Error("Expected LF Received " + c));
        var err = self.onParseHeadersEnd(i + 1);
        if (err) return self.handleError(err);
        state = PART_DATA_START;
        break;
      case PART_DATA_START:
        state = PART_DATA;
        self.partDataMark = i;
        /* falls through */
      case PART_DATA:
        prevIndex = index;

        if (index === 0) {
          // boyer-moore derrived algorithm to safely skip non-boundary data
          i += boundaryEnd;
          while (i < bufferLength && !(buffer[i] in boundaryChars)) {
            i += boundaryLength;
          }
          i -= boundaryEnd;
          c = buffer[i];
        }

        if (index < boundaryLength) {
          if (boundary[index] === c) {
            if (index === 0) {
              self.onParsePartData(buffer.slice(self.partDataMark, i));
              self.partDataMark = null;
            }
            index++;
          } else {
            index = 0;
          }
        } else if (index === boundaryLength) {
          index++;
          if (c === CR) {
            // CR = part boundary
            self.partBoundaryFlag = true;
          } else if (c === HYPHEN) {
            index = 1;
            state = CLOSE_BOUNDARY;
            break;
          } else {
            index = 0;
          }
        } else if (index - 1 === boundaryLength)  {
          if (self.partBoundaryFlag) {
            index = 0;
            if (c === LF) {
              self.partBoundaryFlag = false;
              self.onParsePartEnd();
              self.onParsePartBegin();
              state = HEADER_FIELD_START;
              break;
            }
          } else {
            index = 0;
          }
        }

        if (index > 0) {
          // when matching a possible boundary, keep a lookbehind reference
          // in case it turns out to be a false lead
          lookbehind[index-1] = c;
        } else if (prevIndex > 0) {
          // if our boundary turned out to be rubbish, the captured lookbehind
          // belongs to partData
          self.onParsePartData(lookbehind.slice(0, prevIndex));
          prevIndex = 0;
          self.partDataMark = i;

          // reconsider the current character even so it interrupted the sequence
          // it could be the beginning of a new sequence
          i--;
        }

        break;
      case CLOSE_BOUNDARY:
        if (c !== HYPHEN) return self.handleError(new Error("Expected HYPHEN Received " + c));
        if (index === 1) {
          self.onParsePartEnd();
          self.end();
          state = END;
        } else if (index > 1) {
          return self.handleError(new Error("Parser has invalid state."));
        }
        index++;
        break;
      case END:
        break;
      default:
        self.handleError(new Error("Parser has invalid state."));
        return;
    }
  }

  if (self.headerFieldMark != null) {
    self.onParseHeaderField(buffer.slice(self.headerFieldMark));
    self.headerFieldMark = 0;
  }
  if (self.headerValueMark != null) {
    self.onParseHeaderValue(buffer.slice(self.headerValueMark));
    self.headerValueMark = 0;
  }
  if (self.partDataMark != null) {
    self.onParsePartData(buffer.slice(self.partDataMark));
    self.partDataMark = 0;
  }

  self.index = index;
  self.state = state;

  self.bytesReceived += buffer.length;
  self.emit('progress', self.bytesReceived, self.bytesExpected);

  if (self.backpressure) {
    self.writeCbs.push(cb);
  } else {
    cb();
  }
};

Form.prototype.onParsePartBegin = function() {
  clearPartVars(this);
}

Form.prototype.onParseHeaderField = function(b) {
  this.headerField += this.headerFieldDecoder.write(b);
}

Form.prototype.onParseHeaderValue = function(b) {
  this.headerValue += this.headerValueDecoder.write(b);
}

Form.prototype.onParseHeaderEnd = function() {
  this.headerField = this.headerField.toLowerCase();
  this.partHeaders[this.headerField] = this.headerValue;

  var m;
  if (this.headerField === 'content-disposition') {
    if (m = this.headerValue.match(/\bname="([^"]+)"/i)) {
      this.partName = m[1];
    }
    this.partFilename = parseFilename(this.headerValue);
  } else if (this.headerField === 'content-transfer-encoding') {
    this.partTransferEncoding = this.headerValue.toLowerCase();
  }

  this.headerFieldDecoder = new StringDecoder(this.encoding);
  this.headerField = '';
  this.headerValueDecoder = new StringDecoder(this.encoding);
  this.headerValue = '';
}

Form.prototype.onParsePartData = function(b) {
  if (this.partTransferEncoding === 'base64') {
    this.backpressure = ! this.destStream.write(b.toString('ascii'), 'base64');
  } else {
    this.backpressure = ! this.destStream.write(b);
  }
}

Form.prototype.onParsePartEnd = function() {
  if (this.destStream) {
    flushWriteCbs(this);
    var s = this.destStream;
    process.nextTick(function() {
      s.end();
    });
  }
  clearPartVars(this);
}

Form.prototype.onParseHeadersEnd = function(offset) {
  var self = this;
  switch(self.partTransferEncoding){
    case 'binary':
    case '7bit':
    case '8bit':
    self.partTransferEncoding = 'binary';
    break;

    case 'base64': break;
    default:
    return new Error("unknown transfer-encoding: " + self.partTransferEncoding);
  }

  self.totalFieldCount += 1;
  if (self.totalFieldCount >= self.maxFields) {
    return new Error("maxFields " + self.maxFields + " exceeded.");
  }

  self.destStream = new stream.PassThrough();
  self.destStream.on('drain', function() {
    flushWriteCbs(self);
  });
  self.destStream.headers = self.partHeaders;
  self.destStream.name = self.partName;
  self.destStream.filename = self.partFilename;
  self.destStream.byteOffset = self.bytesReceived + offset;
  var partContentLength = self.destStream.headers['content-length'];
  self.destStream.byteCount = partContentLength ? parseInt(partContentLength, 10) :
    self.bytesExpected ? (self.bytesExpected - self.destStream.byteOffset -
      self.boundary.length - LAST_BOUNDARY_SUFFIX_LEN) :
    undefined;

  self.emit('part', self.destStream);
  if (self.destStream.filename == null && self.autoFields) {
    handleField(self, self.destStream);
  } else if (self.destStream.filename != null && self.autoFiles) {
    handleFile(self, self.destStream);
  }
}

function flushWriteCbs(self) {
  self.writeCbs.forEach(function(cb) {
    process.nextTick(cb);
  });
  self.writeCbs = [];
  self.backpressure = false;
}

function getBytesExpected(headers) {
  var contentLength = headers['content-length'];
  if (contentLength) {
    return parseInt(contentLength, 10);
  } else if (headers['transfer-encoding'] == null) {
    return 0;
  } else {
    return null;
  }
}

function beginFlush(self) {
  self.flushing += 1;
}

function endFlush(self) {
  self.flushing -= 1;
  maybeClose(self);
}

function maybeClose(self) {
  if (!self.flushing && self.finished && !self.error) {
    process.nextTick(function() {
      self.emit('close');
    });
  }
}

function destroyFile(self, file) {
  if (!file.ws) return;
  file.ws.removeAllListeners('close');
  file.ws.on('close', function() {
    fs.unlink(file.path, function(err) {
      if (err && !self.error) self.handleError(err);
    });
  });
  file.ws.destroy();
}

function handleFile(self, fileStream) {
  if (self.error) return;
  beginFlush(self);
  var file = {
    fieldName: fileStream.name,
    originalFilename: fileStream.filename,
    path: uploadPath(self.uploadDir, fileStream.filename),
    headers: fileStream.headers,
  };
  file.ws = fs.createWriteStream(file.path);
  self.openedFiles.push(file);
  fileStream.pipe(file.ws);
  var counter = new StreamCounter();
  var seenBytes = 0;
  fileStream.pipe(counter);
  var hashWorkaroundStream
    , hash = null;
  if (self.hash) {
    // workaround stream because https://github.com/joyent/node/issues/5216
    hashWorkaroundStream = stream.Writable();
    hash = crypto.createHash(self.hash);
    hashWorkaroundStream._write = function(buffer, encoding, callback) {
      hash.update(buffer);
      callback();
    };
    fileStream.pipe(hashWorkaroundStream);
  }
  counter.on('progress', function() {
    var deltaBytes = counter.bytes - seenBytes;
    seenBytes += deltaBytes;
    self.totalFileSize += deltaBytes;
    if (self.totalFileSize > self.maxFilesSize) {
      if (hashWorkaroundStream) fileStream.unpipe(hashWorkaroundStream);
      fileStream.unpipe(counter);
      fileStream.unpipe(file.ws);
      self.handleError(new Error("maxFilesSize " + self.maxFilesSize + " exceeded"));
    }
  });
  file.ws.on('error', function(err) {
    if (!self.error) self.handleError(err);
  });
  file.ws.on('close', function() {
    if (hash) file.hash = hash.digest('hex');
    file.size = counter.bytes;
    self.emit('file', fileStream.name, file);
    endFlush(self);
  });
}

function handleField(self, fieldStream) {
  var value = '';
  var decoder = new StringDecoder(self.encoding);

  beginFlush(self);
  fieldStream.on('readable', function() {
    var buffer = fieldStream.read();
    if (!buffer) return;

    self.totalFieldSize += buffer.length;
    if (self.totalFieldSize > self.maxFieldsSize) {
      self.handleError(new Error("maxFieldsSize " + self.maxFieldsSize + " exceeded"));
      return;
    }
    value += decoder.write(buffer);
  });

  fieldStream.on('end', function() {
    self.emit('field', fieldStream.name, value);
    endFlush(self);
  });
}

function clearPartVars(self) {
  self.partHeaders = {};
  self.partName = null;
  self.partFilename = null;
  self.partTransferEncoding = 'binary';
  self.destStream = null;

  self.headerFieldDecoder = new StringDecoder(self.encoding);
  self.headerField = "";
  self.headerValueDecoder = new StringDecoder(self.encoding);
  self.headerValue = "";
}

function setUpParser(self, boundary) {
  self.boundary = new Buffer(boundary.length + 4);
  self.boundary.write('\r\n--', 0, boundary.length + 4, 'ascii');
  self.boundary.write(boundary, 4, boundary.length, 'ascii');
  self.lookbehind = new Buffer(self.boundary.length + 8);
  self.state = START;
  self.boundaryChars = {};
  for (var i = 0; i < self.boundary.length; i++) {
    self.boundaryChars[self.boundary[i]] = true;
  }

  self.index = null;
  self.partBoundaryFlag = false;

  self.on('finish', function() {
    if ((self.state === HEADER_FIELD_START && self.index === 0) ||
        (self.state === PART_DATA && self.index === self.boundary.length))
    {
      self.onParsePartEnd();
    } else if (self.state !== END) {
      self.handleError(new Error('stream ended unexpectedly'));
    }
    self.finished = true;
    maybeClose(self);
  });
}

function uploadPath(baseDir, filename) {
  var ext = path.extname(filename).replace(FILE_EXT_RE, '$1');
  var name = process.pid + '-' +
    (Math.random() * 0x100000000 + 1).toString(36) + ext;
  return path.join(baseDir, name);
}

function parseFilename(headerValue) {
  var m = headerValue.match(/\bfilename="(.*?)"($|; )/i);
  if (!m) {
    m = headerValue.match(/\bfilename\*=utf-8\'\'(.*?)($|; )/i);
    if (m) {
      m[1] = decodeURI(m[1]);
    }
    else {
      return;
    }
  }

  var filename = m[1].substr(m[1].lastIndexOf('\\') + 1);
  filename = filename.replace(/%22/g, '"');
  filename = filename.replace(/&#([\d]{4});/g, function(m, code) {
    return String.fromCharCode(code);
  });
  return filename;
}

function lower(c) {
  return c | 0x20;
}

