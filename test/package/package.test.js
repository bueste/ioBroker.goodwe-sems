const path = require("path");
const { tests } = require("@iobroker/testing");

// Standard ioBroker consistency checks: validates that package.json and
// io-package.json exist, are valid JSON, and agree with each other
// (version, name, ...). This is the same boilerplate @iobroker/create-adapter
// generates and that the ioBroker repository checker expects to be present.
tests.packageFiles(path.join(__dirname, "..", ".."));
