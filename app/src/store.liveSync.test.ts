import { afterEach, describe, expect, it, vi } from "vitest";
import { api, listenMail } from "@/lib/bridge";
import { useApp } from "@/store";

vi.mock("@/lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bridge")>();
  return { ...actual, listenMail: vi.fn() };
});

afterEach(() => {
  useApp.setState({ liveSyncStarted: false, autoOrganize: false });
  vi.restoreAllMocks();
});

describe("live sync visibility", () => {
  it("skips hidden UI refreshes and refreshes once when visible again", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    vi.mocked(listenMail).mockResolvedValue(() => {});
    const listThreads = vi.spyOn(api, "listThreads");
    useApp.setState({ liveSyncStarted: false, autoOrganize: false });

    await useApp.getState().startLiveSync();
    const onSync = vi.mocked(listenMail).mock.calls[0][0].onSync;
    await onSync?.();
    expect(listThreads).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledTimes(1));
  });
});
