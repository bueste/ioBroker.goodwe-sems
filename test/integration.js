const path = require("node:path");
const { tests } = require("@iobroker/testing");

// Run integration tests - starts a real js-controller + adapter instance.
// See https://github.com/ioBroker/testing for a detailed explanation and further options.
//
// This adapter has no local/LAN device to talk to (it polls the GoodWe SEMS cloud
// portal), so CI has no real account credentials. The smoke test below only verifies
// that the adapter starts, registers itself as alive and shuts down cleanly - it does
// not assert that a login against the real cloud API succeeds.
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("Adapter startup", (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it("should start and report itself as alive", async function () {
                this.timeout(60000);

                await harness.startAdapterAndWait();

                if (!harness.isAdapterRunning()) {
                    throw new Error("Adapter process is not running after startup");
                }
            });
        });
    },
});
