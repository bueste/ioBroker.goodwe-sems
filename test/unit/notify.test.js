"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const { Notifier } = require("../../lib/notify");

function fakeAdapter() {
    return {
        log: { error: sinon.spy(), warn: sinon.spy(), debug: sinon.spy(), info: sinon.spy() },
        sendToAsync: sinon.stub().resolves(),
    };
}

describe("lib/notify Notifier", () => {
    let clock;

    afterEach(() => {
        if (clock) {
            clock.restore();
            clock = undefined;
        }
        sinon.restore();
    });

    it("always logs locally, even when Pushover is disabled", async () => {
        const adapter = fakeAdapter();
        const notifier = new Notifier(adapter, { pushoverMode: "none" });
        await notifier.notify("adapterError", "Titel", "Nachricht");
        expect(adapter.log.error.calledOnce).to.equal(true);
        expect(adapter.sendToAsync.called).to.equal(false);
    });

    it("does nothing beyond logging if the category is disabled in config", async () => {
        const adapter = fakeAdapter();
        const notifier = new Notifier(adapter, { pushoverMode: "instance", pushoverInstance: "pushover.0", notifyOnLoginFailure: false });
        await notifier.notify("loginFailure", "Titel", "Nachricht");
        expect(adapter.sendToAsync.called).to.equal(false);
    });

    it("forwards to the configured pushover instance via sendTo", async () => {
        const adapter = fakeAdapter();
        const notifier = new Notifier(adapter, { pushoverMode: "instance", pushoverInstance: "pushover.0" });
        await notifier.notify("rateLimit", "Titel", "Nachricht");
        expect(adapter.sendToAsync.calledOnce).to.equal(true);
        expect(adapter.sendToAsync.firstCall.args[0]).to.equal("pushover.0");
        expect(adapter.sendToAsync.firstCall.args[1]).to.equal("send");
    });

    it("warns (but does not throw) if 'instance' mode is selected without an instance configured", async () => {
        const adapter = fakeAdapter();
        const notifier = new Notifier(adapter, { pushoverMode: "instance", pushoverInstance: "" });
        await notifier.notify("rateLimit", "Titel", "Nachricht");
        expect(adapter.log.warn.called).to.equal(true);
    });

    it("de-duplicates repeated notifications for the same category within the cool-down window", async () => {
        clock = sinon.useFakeTimers(Date.now());
        const adapter = fakeAdapter();
        const notifier = new Notifier(adapter, { pushoverMode: "instance", pushoverInstance: "pushover.0" });

        await notifier.notify("stationOffline", "Titel", "Nachricht 1");
        await notifier.notify("stationOffline", "Titel", "Nachricht 2");
        expect(adapter.sendToAsync.callCount).to.equal(1);

        clock.tick(61 * 60 * 1000); // advance past the 1h default dedupe window
        await notifier.notify("stationOffline", "Titel", "Nachricht 3");
        expect(adapter.sendToAsync.callCount).to.equal(2);
    });

    it("resetDedupe() allows an immediate re-send", async () => {
        const adapter = fakeAdapter();
        const notifier = new Notifier(adapter, { pushoverMode: "instance", pushoverInstance: "pushover.0" });

        await notifier.notify("loginFailure", "Titel", "Nachricht 1");
        notifier.resetDedupe("loginFailure");
        await notifier.notify("loginFailure", "Titel", "Nachricht 2");

        expect(adapter.sendToAsync.callCount).to.equal(2);
    });
});
