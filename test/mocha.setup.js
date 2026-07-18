// Shared mocha bootstrap for unit tests.
process.env.NODE_ENV = "test";

const chai = require("chai");
chai.use(require("chai-as-promised"));
