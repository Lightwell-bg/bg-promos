import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import collectionFixture from "../../__fixtures__/admin/collection.json";
import { LangProvider } from "../../i18n/LangContext";
import { Collection, validateSlots } from "./Collection";

interface Req {
  method: string;
  url: string;
  body?: unknown;
}

let reqs: Req[] = [];
let data: typeof collectionFixture;
let putStatus = 200;
let runCreated = true;
/** When set, non-GET requests wait for it (simulates a slow mutation). */
let gate: Promise<void> | null = null;

function json(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function handle(method: string, url: string, init?: RequestInit): Response {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  reqs.push({ method, url, body });
  if (method === "GET" && url.startsWith("/api/admin/collection")) return json(200, data);
  if (method === "PUT" && url.startsWith("/api/admin/collection/schedule/")) {
    if (putStatus === 409) {
      // Someone else changed the schedule: the reloaded data carries a newer revision.
      data = structuredClone(data);
      data.chains[1].schedule.revision = 4;
      return json(409, { detail: "stale", current: data.chains[1].schedule });
    }
    if (putStatus === 422) return json(422, { detail: "slot 25:00 is invalid" });
    return json(200, { ...data.chains[1].schedule, slots: body.slots, revision: body.revision + 1 });
  }
  if (method === "POST" && url.startsWith("/api/admin/collection/run/")) {
    data = structuredClone(data);
    data.chains[0].pending_request = { id: 5, requested_at: "2026-10-25T10:30:00+00:00" } as never;
    return json(runCreated ? 202 : 200, { request: { id: 5, requested_at: "2026-10-25T10:30:00+00:00" }, created: runCreated });
  }
  return json(404);
}

beforeEach(() => {
  reqs = [];
  data = structuredClone(collectionFixture);
  putStatus = 200;
  runCreated = true;
  gate = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET" && gate) await gate;
      return handle(method, url, init);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderCollection() {
  const onAuthLost = vi.fn();
  render(
    <LangProvider lang="ru">
      <Collection onAuthLost={onAuthLost} />
    </LangProvider>,
  );
  await screen.findByRole("region", { name: "Lidl" });
  return { onAuthLost };
}

describe("Collection tab", () => {
  it("renders chain cards with last run, period stats and Sofia time", async () => {
    await renderCollection();
    const lidl = screen.getByRole("region", { name: "Lidl" });
    expect(within(lidl).getByText("успешно")).toBeInTheDocument();
    expect(within(lidl).getByText(/640 \(активных: 600\)/)).toBeInTheDocument();
    expect(within(lidl).getByText(/10 \(успешно 9, подозрительных 1, с ошибкой 0\)/)).toBeInTheDocument();
    expect(within(lidl).getByText("90%")).toBeInTheDocument();
    // 04:00:05 UTC on 25 Oct 2026 is 06:00 in Sofia (DST ended that night: EET, UTC+2).
    expect(within(lidl).getByText(/25\.10\.2026.*06:00 · по расписанию/)).toBeInTheDocument();
    expect(within(lidl).getByText(/сбор начинается при ближайшем запуске cron/)).toBeInTheDocument();
    expect(within(lidl).queryByText("устарело")).not.toBeInTheDocument();
  });

  it("shows the stale warning", async () => {
    await renderCollection();
    const kaufland = screen.getByRole("region", { name: "Kaufland" });
    expect(within(kaufland).getByText("устарело")).toBeInTheDocument();
  });

  it("greys out a chain disabled in config.ini and gives it no controls", async () => {
    await renderCollection();
    const billa = screen.getByRole("region", { name: "BILLA" });
    expect(within(billa).getByText("отключён в config.ini")).toBeInTheDocument();
    expect(within(billa).queryAllByRole("button")).toHaveLength(0);
    expect(within(billa).queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders error text as plain text, not HTML", async () => {
    const { container } = render(
      <LangProvider lang="ru">
        <Collection onAuthLost={() => undefined} />
      </LangProvider>,
    );
    await screen.findByRole("region", { name: "Kaufland" });
    const kaufland = screen.getByRole("region", { name: "Kaufland" });
    expect(within(kaufland).getByText("<img src=x onerror=alert(1)> boom")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("saves the schedule with the loaded revision", async () => {
    await renderCollection();
    const kaufland = screen.getByRole("region", { name: "Kaufland" });
    await userEvent.click(within(kaufland).getByRole("button", { name: "Добавить время" }));
    await userEvent.click(within(kaufland).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(reqs.some((r) => r.method === "PUT")).toBe(true));
    const put = reqs.find((r) => r.method === "PUT")!;
    expect(put.url).toBe("/api/admin/collection/schedule/kaufland");
    expect(put.body).toEqual({ enabled: true, slots: ["06:00", "00:00"], revision: 3 });
  });

  it("on 409 shows the notice and reloads the data", async () => {
    putStatus = 409;
    await renderCollection();
    const getsBefore = reqs.filter((r) => r.method === "GET").length;
    const kaufland = screen.getByRole("region", { name: "Kaufland" });
    await userEvent.click(within(kaufland).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Расписание изменили в другом окне — данные обновлены")).toBeInTheDocument();
    await waitFor(() => expect(reqs.filter((r) => r.method === "GET").length).toBeGreaterThan(getsBefore));
  });

  it("shows the 422 error from the server", async () => {
    putStatus = 422;
    await renderCollection();
    const kaufland = screen.getByRole("region", { name: "Kaufland" });
    await userEvent.click(within(kaufland).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("slot 25:00 is invalid")).toBeInTheDocument();
  });

  it("blocks saving an invalid slot", async () => {
    await renderCollection();
    const kaufland = screen.getByRole("region", { name: "Kaufland" });
    await userEvent.clear(within(kaufland).getByLabelText("Время 1"));
    await userEvent.click(within(kaufland).getByRole("button", { name: "Сохранить" }));
    expect(await within(kaufland).findByText(/формате ЧЧ:ММ/)).toBeInTheDocument();
    expect(reqs.some((r) => r.method === "PUT")).toBe(false);
  });

  it("validates duplicates, empty list and the 24-slot limit", () => {
    expect(validateSlots(true, [])).toMatch(/хотя бы одно/);
    expect(validateSlots(false, [])).toBeNull();
    expect(validateSlots(true, ["07:00", "07:00"])).toMatch(/повторяется/);
    expect(validateSlots(true, ["24:00"])).toMatch(/формате/);
    const many = Array.from({ length: 25 }, (_, i) => `${String(i % 24).padStart(2, "0")}:00`);
    expect(validateSlots(true, many)).toMatch(/Не больше 24/);
  });

  it("offers a reset only for an admin override", async () => {
    await renderCollection();
    const lidl = screen.getByRole("region", { name: "Lidl" });
    const kaufland = screen.getByRole("region", { name: "Kaufland" });
    expect(within(lidl).queryByRole("button", { name: "Сбросить к config.ini" })).not.toBeInTheDocument();
    await userEvent.click(within(kaufland).getByRole("button", { name: "Сбросить к config.ini" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("queues a run and shows the pending state", async () => {
    await renderCollection();
    const lidl = screen.getByRole("region", { name: "Lidl" });
    await userEvent.click(within(lidl).getByRole("button", { name: "Собрать сейчас" }));
    // 10:30 UTC is 12:30 in Sofia (EET, UTC+2).
    expect(await within(lidl).findByText(/В очереди с 12:30 — запустится при ближайшем часовом запуске/)).toBeInTheDocument();
    expect(within(lidl).getByRole("button", { name: "Собрать сейчас" })).toBeDisabled();
    expect(reqs.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("shows the result of the last manual run", async () => {
    await renderCollection();
    const kaufland = screen.getByRole("region", { name: "Kaufland" });
    expect(within(kaufland).getByText(/Последний ручной запуск: успешно/)).toBeInTheDocument();
  });

  it("filters recent runs by chain and switches the period", async () => {
    await renderCollection();
    await userEvent.selectOptions(screen.getByLabelText("Сеть"), "kaufland");
    await waitFor(() => expect(reqs.some((r) => r.url.includes("chain=kaufland"))).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "30 дней" }));
    await waitFor(() => expect(reqs.some((r) => r.url.includes("days=30"))).toBe(true));
  });

  it("refreshes after a slow mutation with the CURRENT period, not the one captured at click time", async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    await renderCollection();
    const lidl = screen.getByRole("region", { name: "Lidl" });
    await userEvent.click(within(lidl).getByRole("button", { name: "Собрать сейчас" }));
    // the POST is held by the gate, so the card is busy (button disabled) while the period is switched
    await waitFor(() => expect(within(lidl).getByRole("button", { name: "Собрать сейчас" })).toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "30 дней" }));
    await waitFor(() => expect(reqs.some((r) => r.url.includes("days=30"))).toBe(true));
    const before = reqs.length;
    release();
    await waitFor(() => expect(reqs.length).toBeGreaterThan(before));
    await within(lidl).findByText(/В очереди с 12:30/);
    const gets = reqs.slice(before).filter((r) => r.method === "GET");
    expect(gets.length).toBeGreaterThan(0);
    expect(gets.every((r) => r.url.includes("days=30"))).toBe(true);
    expect(reqs.filter((r) => r.method === "GET").at(-1)!.url).toContain("days=30");
  });

  it("disables the whole schedule editor while saving", async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    await renderCollection();
    const kaufland = screen.getByRole("region", { name: "Kaufland" });
    await userEvent.click(within(kaufland).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(within(kaufland).getByLabelText("Время 1")).toBeDisabled());
    expect(within(kaufland).getByRole("checkbox")).toBeDisabled();
    expect(within(kaufland).getByRole("button", { name: "Добавить время" })).toBeDisabled();
    release();
    await waitFor(() => expect(within(kaufland).getByLabelText("Время 1")).toBeEnabled());
  });

  it("labels an interrupted manual run", async () => {
    data.chains[1].last_request = { ...data.chains[1].last_request!, status: "interrupted" } as never;
    await renderCollection();
    const kaufland = screen.getByRole("region", { name: "Kaufland" });
    expect(within(kaufland).getByText(/Последний ручной запуск: прерван/)).toBeInTheDocument();
  });
});
