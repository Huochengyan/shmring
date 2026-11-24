'use strict';

class ShmRingError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name; // CapacityError, ProtocolError, ...
  }
}
class ProtocolError extends ShmRingError {}
class SegmentNotFound extends ShmRingError {}
class SegmentExists extends ShmRingError {}
class CapacityError extends ShmRingError {}
class ChecksumError extends ShmRingError {}

module.exports = {
  ShmRingError, ProtocolError, SegmentNotFound, SegmentExists, CapacityError, ChecksumError,
};
