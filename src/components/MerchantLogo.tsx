import { useBrandLogo } from "../lib/brandLogos";

const MELBET_LOGO =
  "https://play-lh.googleusercontent.com/sY10bJqcHlRijOZXjIyWcejedc27K4v2WgzmuUphLVkVf4lBN_1_CQXON3CoIMC96ZQvUBI-1GCz5eHUxOUGUQ";
const EZINVEST_LOGO =
  "https://consumersiteimages.trustpilot.net/business-units/5ba3ba86026be000014dccd9-198x149-1x.jpg";
const T365_LOGO =
  "https://media.licdn.com/dms/image/v2/D4E0BAQGF0Cbxg9KOUw/company-logo_200_200/B4EZuNNQKSIMAM-/0/1767600621319/it_support_365_ltd_logo?e=2147483647&v=beta&t=6JEsLB64fnC99PXDenfenMH1XbASwuWgLi9o7N-ebLM";

export default function MerchantLogo({
  merchant,
}: {
  merchant: string | null | undefined;
}) {
  const raw = (merchant ?? "").trim();
  const isMelBet = /mel\s*bet/i.test(raw);
  const isEzInvest = /(?:^|[\s_-])ez(?:invest)?(?:$|[\s_-])/i.test(raw);
  const isT365 = /(?:^|[\s_-])t\s*365(?:$|[\s_-])/i.test(raw);
  const uploadedLogo = useBrandLogo("merchant", raw);
  const logo =
    uploadedLogo ??
    (isMelBet
      ? MELBET_LOGO
      : isEzInvest
        ? EZINVEST_LOGO
        : isT365
          ? T365_LOGO
          : null);

  return (
    <span
      className={`merchant-brand-cell${isMelBet || isEzInvest || isT365 ? " merchant-brand-featured" : ""}`}
    >
      {logo ? (
        <img
          className="merchant-brand-logo"
          src={logo}
          alt={raw}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="merchant-brand-fallback" aria-hidden="true">
          {raw ? raw.slice(0, 1).toUpperCase() : "—"}
        </span>
      )}
      <span className="merchant-brand-name">{raw || "—"}</span>
    </span>
  );
}
