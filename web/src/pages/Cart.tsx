import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ChainBadge } from "../components/ChainBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { TrashIcon } from "../components/Icons";
import { OfferImage } from "../components/OfferImage";
import { QtyStepper } from "../components/QtyStepper";
import { useCart } from "../data/CartContext";
import { useCatalog } from "../data/CatalogContext";
import { WeightStepper } from "../components/WeightStepper";
import { gramsOf, hasCard, isWeightLine, WEIGHT_PRESETS } from "../domain/cart";
import { formatWeight } from "../domain/weight";
import type { ChainGroup, ReconciledLine } from "../domain/cart";
import { canShare, encodeShare, encodeStartParam, shareUrl, telegramStartLink } from "../domain/carts";
import { siteOrigin } from "../platform/env";
import { useConfig } from "../data/ConfigContext";
import { conditionChips, formatEUR, priceModel, unitKey } from "../domain/price";
import { CHAIN_NAMES, type ChainId, type Offer } from "../domain/types";
import { useLang, useT } from "../i18n/LangContext";
import { record } from "../platform/analytics";
import { setTitle } from "../platform/document";
import { canNativeShare, copyText, share, telegramShareUrl } from "../platform/share";
import styles from "./Cart.module.css";
import page from "./Page.module.css";

/** "2026-10-19" -> "19.10". */
function shortDate(iso: string | null): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

/** "2026-10-17T08:00:00Z" -> "17.10" (Sofia date). */
function sofiaDayMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", day: "2-digit", month: "2-digit" })
    .format(d)
    .replace("/", ".");
}

type Confirm = { kind: "all" } | { kind: "chain"; chain: ChainId } | { kind: "list"; id: string } | null;

/** One-time message passed (via router state) by the import page. */
export interface ImportNote {
  mode: "filled" | "created" | "existing" | "nothing";
  missing: number;
}

function noteOf(v: unknown): ImportNote | null {
  const n = (v as { importNote?: ImportNote } | null)?.importNote;
  return n && typeof n.mode === "string" && typeof n.missing === "number" ? n : null;
}

export function Cart() {
  const t = useT();
  const lang = useLang();
  const cart = useCart();
  const { catalog } = useCatalog();
  const location = useLocation();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [note, setNote] = useState("");
  const config = useConfig();
  // The panel only remembers that it is open: the links are derived from the CURRENT list on every
  // render, so deleting/changing items while it is open can never leave a stale link to forward.
  const [shareOpen, setShareOpen] = useState(false);
  const webValue = encodeShare(cart.state);
  const tgParam = config.telegram_bot ? encodeStartParam(cart.state) : null;
  const links =
    shareOpen && webValue
      ? {
          tg: config.telegram_bot && tgParam ? telegramStartLink(config.telegram_bot, tgParam) : null,
          web: shareUrl(config.site_url || siteOrigin(), lang, webValue),
        }
      : null;
  useEffect(() => {
    if (shareOpen && !webValue) setShareOpen(false); // list emptied while the panel was open
  }, [shareOpen, webValue]);
  const [copyNote, setCopyNote] = useState<{ block: "tg" | "web"; ok: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [importNote, setImportNote] = useState<ImportNote | null>(() => noteOf(location.state));
  const { summary } = cart;
  const shareState = canShare(cart.state);

  useEffect(() => {
    setTitle(`${t("cart.title")} | ${t("app.name")}`);
  }, [t]);

  // The import banner is shown once: drop it from the history entry so a reload does not repeat it.
  useEffect(() => {
    if (noteOf(location.state)) navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(""), 3000);
    return () => clearTimeout(id);
  }, [note]);

  // Always open a panel with the visible link: Telegram webviews often have no share sheet and
  // deny the clipboard, so a silent navigator.share/clipboard attempt looked like "nothing happens".
  function onShare() {
    // Two links: a t.me link that opens the bot's Mini App directly (needs a configured bot and a list
    // that fits into the 512-char startapp parameter) and the plain web link for the browser.
    if (!cart.shareLink(lang)) {
      setNote(t("cart.shareFailed"));
      return;
    }
    setCopyNote(null);
    setShareOpen(true);
    // Creating a link is not sending it. Counts only: no list contents, no names.
    record("share_link_created", { lines: cart.state.lines.length, telegram: Boolean(config.telegram_bot && tgParam) });
  }

  async function onCopy(block: "tg" | "web", url: string) {
    const ok = await copyText(url);
    record("share_copy", { block, ok });
    setCopyNote({ block, ok });
  }

  async function onSystemShare() {
    if (!links) return;
    const result = await share({ title: t("app.name"), text: t("cart.shareText"), url: links.tg ?? links.web });
    if (result === "copied") setNote(t("cart.shareCopied"));
  }

  function shareBlock(block: "tg" | "web", url: string) {
    const title = t(block === "tg" ? "cart.shareBlockTelegram" : "cart.shareBlockWeb");
    const feedback = copyNote?.block === block ? copyNote : null;
    return (
      <div className={styles.shareBlock} role="group" aria-label={title} data-clarity-mask="true">
        <p className={styles.shareBlockTitle}>{title}</p>
        <input
          className={styles.shareInput}
          readOnly
          value={url}
          aria-label={title}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className={styles.shareActions}>
          {block === "tg" && (
            <a
              className={page.primaryBtn}
              href={telegramShareUrl(url, t("cart.shareText"))}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("cart.shareTelegram")}
            </a>
          )}
          <button type="button" className={page.secondaryBtn} onClick={() => void onCopy(block, url)}>
            {t("cart.copy")}
          </button>
        </div>
        {feedback && (
          <p role="status" className={feedback.ok ? styles.shareNote : styles.shareError}>
            {feedback.ok ? t("cart.shareCopied") : t("cart.shareFailed")}
          </p>
        )}
      </div>
    );
  }

  const sharePanel = links && (
    <div className={styles.sharePanel} role="region" aria-label={t("cart.sharePanelTitle")} data-clarity-mask="true">
      <p className={styles.sharePanelTitle}>{t("cart.sharePanelTitle")}</p>
      {links.tg && shareBlock("tg", links.tg)}
      {shareBlock("web", links.web)}
      <p className={styles.shareHint}>{t("cart.shareHint")}</p>
      {!links.tg && <p className={styles.shareHint}>{t("cart.shareLong")}</p>}
      <div className={styles.shareActions}>
        {canNativeShare() && (
          <button type="button" className={page.secondaryBtn} onClick={() => void onSystemShare()}>
            {t("cart.shareSystem")}
          </button>
        )}
        <button type="button" className={page.secondaryBtn} onClick={() => setShareOpen(false)}>
          {t("cart.shareClose")}
        </button>
      </div>
    </div>
  );

  const listLabel = (l: (typeof cart.lists)[number]) =>
    l.name ?? (l.origin === "own" ? t("cart.listOwn") : t("cart.listShared", { date: sofiaDayMonth(l.createdAt) }));

  const importBanner = importNote && (
    <div className={`${styles.notice} ${importNote.mode === "nothing" ? styles.warn : styles.info}`} role="status">
      <span>
        {t(`cart.import.${importNote.mode}`)}
        {importNote.missing > 0 && <> · {t("cart.import.missing", { n: importNote.missing })}</>}
      </span>
      <button type="button" className={styles.noticeBtn} onClick={() => setImportNote(null)}>
        {t("cart.ok")}
      </button>
    </div>
  );

  const activeList = cart.lists.find((l) => l.active);
  const switcher = cart.lists.length >= 2 && activeList && (
    <div className={styles.lists} data-clarity-mask="true">
      <div className={styles.chips} role="group" aria-label={t("cart.lists")}>
        {cart.lists.map((l) => (
          <button
            key={l.id}
            type="button"
            className={`${styles.listChip} ${l.active ? styles.listChipActive : ""}`}
            aria-pressed={l.active}
            onClick={() => cart.switchList(l.id)}
          >
            {listLabel(l)} · {l.count}
          </button>
        ))}
      </div>
      {renaming === activeList.id ? (
        <form
          className={styles.renameForm}
          onSubmit={(e) => {
            e.preventDefault();
            cart.renameList(activeList.id, draft);
            setRenaming(null);
          }}
        >
          <input
            className={styles.renameInput}
            value={draft}
            maxLength={40}
            aria-label={t("cart.renameLabel")}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <button type="submit" className={page.secondaryBtn}>
            {t("cart.renameSave")}
          </button>
        </form>
      ) : (
        <div className={styles.listActions}>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => {
              setDraft(activeList.name ?? "");
              setRenaming(activeList.id);
            }}
          >
            {t("cart.rename")}
          </button>
          <button type="button" className={styles.linkBtn} onClick={() => setConfirm({ kind: "list", id: activeList.id })}>
            {t("cart.deleteList")}
          </button>
        </div>
      )}
    </div>
  );
  const listDialog = confirm?.kind === "list" && (
    <ConfirmDialog
      title={t("cart.deleteListTitle")}
      text={t("cart.deleteListText")}
      confirmLabel={t("cart.deleteList")}
      onClose={() => setConfirm(null)}
      onConfirm={() => {
        cart.deleteList(confirm.id);
        setConfirm(null);
        setRenaming(null);
      }}
    />
  );

  const icons = new Map((catalog?.categories ?? []).map((c) => [c.id, c.icon]));
  const onQty = (id: string, q: number) => (q < 1 ? cart.remove(id) : cart.setQty(id, q));

  function replacementPrice(o: Offer): string {
    const m = priceModel(o);
    if (m.mainCents == null) return t("price.none");
    return m.qty > 1 ? `${formatEUR(m.mainCents)} ${t("price.perQty", { n: m.qty })}` : formatEUR(m.mainCents);
  }

  function lineView(r: ReconciledLine) {
    const { line, price } = r;
    const total = price.totalCents;
    const ended = r.status === "ended";
    const chip = price.condition
      ? conditionChips(price.condition)
          .map((c) => t(c.key, c.params))
          .join(" · ")
      : total !== null
        ? t("cond.regular")
        : null;
    const approx = r.counted && price.approximate;
    const weight = isWeightLine(line);
    const grams = gramsOf(line);
    const unitLabel = t(unitKey(line.saleUnit));
    const perUnitCents = price.condition?.total_cents ?? r.offer?.regular_cents ?? line.snapshot.regular_cents;
    const perKg = weight && total !== null && perUnitCents != null ? `${formatEUR(perUnitCents)}/${unitLabel}` : null;
    const perItem =
      !weight && line.qty > 1 && total !== null
        ? `${approx || total % line.qty !== 0 ? "≈ " : ""}${t("cart.perItem", { amount: formatEUR(Math.round(total / line.qty)), unit: t(unitKey(line.saleUnit)) })}`
        : null;
    return (
      <li key={line.offerId} className={`${styles.line} ${ended ? styles.ended : ""}`} data-clarity-mask="true">
        <div className={styles.thumb}>
          <OfferImage src={line.imageUrl} alt="" icon={icons.get(line.category) ?? "🛒"} chain={line.chain} />
        </div>
        <div className={styles.lineBody}>
          <div className={styles.lineHead}>
            {r.offer ? (
              <Link to={`/${lang}/offer/${r.offer.id}`} className={styles.name}>
                {line.name}
              </Link>
            ) : (
              <span className={styles.name}>{line.name}</span>
            )}
            <button
              type="button"
              className={styles.iconBtn}
              aria-label={t("cart.remove")}
              title={t("cart.remove")}
              onClick={() => cart.remove(line.offerId)}
            >
              <TrashIcon />
            </button>
          </div>
          {line.unitText && <p className={styles.unit}>{line.unitText}</p>}
          {chip && <span className={styles.chip}>{chip}</span>}

          <div className={styles.lineFoot}>
            {weight ? (
              <WeightStepper grams={grams} onChange={(g) => cart.setGrams(line.offerId, g)} unit={unitLabel} compact />
            ) : (
              <QtyStepper qty={line.qty} onChange={(q) => onQty(line.offerId, q)} compact />
            )}
            <div className={styles.amounts}>
              {total !== null ? (
                <strong className={`${styles.total} ${ended ? styles.struck : ""}`} data-testid="line-total">
                  {approx ? "≈ " : ""}
                  {formatEUR(total)}
                </strong>
              ) : (
                <span className={styles.noPrice}>{t("cart.noPrice")}</span>
              )}
              {perItem && <span className={styles.perItem}>{perItem}</span>}
              {perKg && (
                <span className={styles.perItem} data-testid="line-per-kg">
                  {perKg}
                </span>
              )}
            </div>
          </div>
          {weight && (
            <div className={styles.presets} role="group" aria-label={t("cart.weightPresets")}>
              {WEIGHT_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`${styles.listChip} ${grams === p ? styles.listChipActive : ""}`}
                  aria-pressed={grams === p}
                  onClick={() => cart.setGrams(line.offerId, p)}
                >
                  {formatWeight(p, unitLabel)}
                </button>
              ))}
            </div>
          )}

          {r.priceChanged && r.offer && (
            <div className={`${styles.notice} ${styles.warn}`}>
              <span>
                {t("cart.priceChanged", {
                  was: r.previousTotalCents !== null ? formatEUR(r.previousTotalCents) : "—",
                  now: total !== null ? formatEUR(total) : "—",
                })}
              </span>
              <button type="button" className={styles.noticeBtn} onClick={() => cart.acceptPrice(r.offer as Offer)}>
                {t("cart.ok")}
              </button>
            </div>
          )}
          {r.status === "upcoming" && (
            <div className={`${styles.notice} ${styles.info}`}>
              {t("cart.upcoming", { date: shortDate(r.offer?.valid_from ?? null) })}
            </div>
          )}
          {ended && (
            <div className={`${styles.notice} ${styles.bad}`}>
              <span>{t("cart.ended")}</span>
            </div>
          )}
          {ended && r.replacement && (
            <div className={`${styles.notice} ${styles.info}`}>
              <span>{t("cart.replacement", { price: replacementPrice(r.replacement) })}</span>
              <button
                type="button"
                className={styles.noticeBtn}
                onClick={() => cart.replace(line.offerId, r.replacement as Offer)}
              >
                {t("cart.replace")}
              </button>
            </div>
          )}
          {r.status === "unknown" && <div className={`${styles.notice} ${styles.info}`}>{t("cart.unknown")}</div>}
          {approx && <div className={`${styles.notice} ${styles.info}`}>{t("cart.approxNote")}</div>}
          {!ended && price.addForDeal && (
            <div className={`${styles.notice} ${styles.hint}`}>
              {t("cart.addForDeal", { add: price.addForDeal.add, min: price.addForDeal.minQty })}
            </div>
          )}
          {price.cardOnly && total === null && (
            <div className={`${styles.notice} ${styles.warn}`}>{t("cart.cardOnly")}</div>
          )}
        </div>
      </li>
    );
  }

  function groupView(g: ChainGroup) {
    const program = t(`cart.program.${g.chain}`);
    const has = hasCard(cart.state.cards, g.chain);
    return (
      <section key={g.chain} className={`${styles.group} ${styles[g.chain]}`} aria-label={CHAIN_NAMES[g.chain]}>
        <div className={styles.groupHead}>
          <ChainBadge chain={g.chain} />
          <button type="button" className={styles.linkBtn} onClick={() => setConfirm({ kind: "chain", chain: g.chain })}>
            {t("cart.clearChain")}
          </button>
        </div>
        <label className={styles.cardToggle}>
          <input
            type="checkbox"
            checked={has}
            onChange={(e) => cart.setCard(g.chain, e.target.checked)}
          />
          <span>{t("cart.haveCard", { program })}</span>
        </label>
        <ul className={styles.lines}>{g.lines.map(lineView)}</ul>
        <div className={styles.subtotal}>
          <span>{t("cart.subtotal")}</span>
          <strong data-testid={`subtotal-${g.chain}`}>
            {g.approximate ? "≈ " : ""}
            {formatEUR(g.subtotalCents)}
          </strong>
        </div>
      </section>
    );
  }

  if (summary.groups.length === 0) {
    return (
      <div>
        <h1 className={page.title}>{t("cart.title")}</h1>
        {importBanner}
        {switcher}
        {listDialog}
        <EmptyState icon="🛒" text={t("cart.empty")}>
          <p className={styles.emptyHint}>{t("cart.emptyHint")}</p>
          <Link to={`/${lang}/catalog`} className={page.primaryBtn}>
            {t("nav.catalog")}
          </Link>
        </EmptyState>
      </div>
    );
  }

  const confirmChain = confirm?.kind === "chain" ? confirm.chain : null;
  const usesCard = summary.groups.some((g) =>
    g.lines.some((l) => l.counted && l.price.totalCents !== null && l.price.condition?.program),
  );
  return (
    <div>
      <div className={styles.head}>
        <div>
          <h1 className={page.title}>{t("cart.title")}</h1>
          <p className={styles.count}>{t("cart.itemsCount", { n: cart.count })}</p>
        </div>
        <div className={styles.headActions}>
          <button
            type="button"
            className={page.secondaryBtn}
            disabled={shareState === "too_many"}
            title={shareState === "too_many" ? t("cart.shareTooMany") : undefined}
            onClick={onShare}
          >
            {t("cart.share")}
          </button>
          <button type="button" className={page.secondaryBtn} onClick={() => setConfirm({ kind: "all" })}>
            {t("cart.clear")}
          </button>
        </div>
      </div>
      {shareState === "too_many" && (
        <p role="status" className={styles.shareNote}>
          {t("cart.shareTooMany")}
        </p>
      )}
      {note && (
        <p role="status" className={styles.shareNote}>
          {note}
        </p>
      )}
      {sharePanel}
      {importBanner}
      {switcher}

      {summary.groups.map(groupView)}

      <div className={styles.summary} aria-live="polite">
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>
            {t("cart.total")} · {t("cart.itemsInTotal", { n: summary.items })}
          </span>
          <strong className={styles.summaryTotal} data-testid="grand-total">
            {summary.approximate ? "≈ " : ""}
            {formatEUR(summary.totalCents)}
          </strong>
        </div>
        {summary.excluded > 0 && <p className={styles.excluded}>{t("cart.excluded", { n: summary.excluded })}</p>}
        {usesCard && <p className={styles.disclaimer}>{t("cart.cardPrices")}</p>}
        <p className={styles.disclaimer}>{t("cart.disclaimer")}</p>
      </div>

      {listDialog}
      {confirm?.kind === "all" && (
        <ConfirmDialog
          title={t("cart.clearTitle")}
          text={t("cart.clearText")}
          confirmLabel={t("cart.confirm")}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            cart.clear();
            setConfirm(null);
          }}
        />
      )}
      {confirmChain && (
        <ConfirmDialog
          title={t("cart.clearChainTitle", { chain: CHAIN_NAMES[confirmChain] })}
          text={t("cart.clearChainText")}
          confirmLabel={t("cart.confirm")}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            cart.clearChain(confirmChain);
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
