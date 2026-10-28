/**
 * An icon for each model, guessed from what it is called and, when its name says nothing, from its shape: the
 * studio shows a `user` as a person and an `invoice` as a receipt without the schema saying anything. The name is
 * read word by word (`blogPost`, `blog_posts` → `blog`, `post`), plural or singular, the last word first: it says
 * what the row is (`userProfile` is a profile). A model whose name says nothing is read by its shape (a row joining
 * two others, an email and a password), else keeps the table icon.
 */

import type { StudioModel } from "./schema";

/** Each icon and the words that call for it, the first match winning. Icon names are entasis's (Phosphor). */
export const ICON_RULES = [
  ["link", "link|url|redirect|shortlink|permalink|join|junction|pivot"],
  // People.
  ["userCircle", "profile|avatar|bio|persona"],
  [
    "users",
    "member|membership|follower|following|follow|friend|friendship|subscriber|attendee|participant|collaborator|contributor|assignee",
  ],
  ["usersThree", "team|group|community|squad|club|crew|cohort|guild|circle"],
  ["userPlus", "invitation|invite|referral|signup|registration|onboarding"],
  ["addressBook", "contact|lead|prospect|directory|phonebook"],
  ["identificationCard", "identity|kyc|passport|idcard|badge"],
  ["student", "student|learner|pupil|alumnus|alumni"],
  ["chalkboardTeacher", "teacher|instructor|tutor|mentor|coach|classroom"],
  ["stethoscope", "doctor|physician|clinic|hospital|practitioner|nurse"],
  ["heartbeat", "patient|health|vital|symptom|diagnosis|medical|condition"],
  ["pill", "medication|medicine|prescription|drug|pill|dose|pharmacy"],
  [
    "user",
    "user|account|customer|client|person|people|author|owner|admin|administrator|staff|employee|player|creator|visitor|guest|buyer|operator|actor|individual|human|resident|driver|rider|passenger|candidate|applicant|volunteer|speaker|organizer|moderator|editor|reviewer|approver|signer|recipient|sender",
  ],
  // Writing and media.
  ["newspaper", "news|newsletter|press|digest|bulletin|headline|magazine"],
  [
    "article",
    "post|article|blog|story|entry|page|content|essay|publication|writeup|changelog",
  ],
  ["note", "note|memo|draft|annotation|remark|sticky"],
  ["notebook", "journal|diary|notebook|logbook"],
  [
    "bookOpen",
    "book|chapter|glossary|guide|manual|doc|documentation|knowledge|wiki|handbook|tutorial",
  ],
  [
    "chatCircle",
    "comment|reply|feedback|discussion|thread|response|answer|mention",
  ],
  ["chatText", "message|chat|conversation|dm|text|sms"],
  ["chatsCircle", "chatroom|forum"],
  ["quotes", "testimonial|citation|excerpt"],
  ["question", "question|faq|inquiry|enquiry|poll|quiz"],
  ["clipboardText", "survey|form|questionnaire|submission"],
  [
    "megaphone",
    "announcement|campaign|broadcast|ad|advert|advertisement|promotion|promo",
  ],
  ["tag", "tag|label|keyword|hashtag|topic|tagging"],
  [
    "folder",
    "category|folder|section|genre|subcategory|taxonomy|classification|department",
  ],
  [
    "stack",
    "collection|list|playlist|bundle|set|board|stack|batch|series|catalog|catalogue|library|shelf|lineup",
  ],
  [
    "image",
    "image|photo|picture|gallery|media|thumbnail|banner|cover|logo|icon|illustration|artwork|screenshot|sticker",
  ],
  [
    "videoCamera",
    "video|clip|stream|livestream|movie|film|episode|recording|webinar|reel|show",
  ],
  ["musicNote", "song|track|music|album|audio|podcast|sound|artist|band|lyric"],
  ["microphone", "voice|speech|transcript|transcription|dictation"],
  ["paperclip", "attachment|upload"],
  ["file", "file|document|blob|object|resource|asset|binary|pdf|download"],
  [
    "code",
    "code|snippet|script|gist|function|query|macro|template|component|widget",
  ],
  ["translate", "translation|i18n|localization|locale|language|dictionary"],
  ["bookmark", "bookmark|saved|save|pin|readlater"],
  ["heart", "like|favorite|favourite|reaction|wishlist|love|kudos|clap"],
  ["thumbsUp", "vote|upvote|downvote|endorsement|approval|recommendation"],
  ["star", "review|rating|star|score|grade|ranking|rank"],
  ["smiley", "emoji|mood|sentiment|emotion"],
  // Commerce.
  ["shoppingCart", "cart|basket|checkout|order|purchase|sale|preorder"],
  [
    "receipt",
    "invoice|bill|billing|receipt|lineitem|orderline|estimate|quotation|statement|quote|orderitem|cartitem|invoiceitem",
  ],
  [
    "creditCard",
    "payment|charge|card|transaction|transfer|payout|refund|chargeback|paymentmethod",
  ],
  ["percent", "discount|coupon|voucher|rebate|markdown|tax|vat"],
  ["coins", "credit|coin|point|reward|loyalty|cashback|balance"],
  ["piggyBank", "saving|savings|deposit|fund"],
  [
    "money",
    "revenue|income|expense|budget|salary|payroll|donation|tip|fee|cost|spend|commission|earning",
  ],
  ["wallet", "wallet|purse"],
  ["bank", "bank|ledger|treasury|bankaccount|iban|loan|mortgage"],
  [
    "currencyDollar",
    "price|pricing|plan|subscription|tier|rate|currency|amount|offer",
  ],
  ["gift", "gift|giftcard|bonus|prize|perk|present"],
  [
    "storefront",
    "shop|store|merchant|vendor|supplier|marketplace|brand|retailer|outlet|seller",
  ],
  [
    "package",
    "product|item|sku|inventory|stock|good|goods|merchandise|parcel|package|variant",
  ],
  ["warehouse", "warehouse|depot|fulfillment|fulfilment|storage"],
  [
    "truck",
    "shipment|shipping|delivery|carrier|logistic|logistics|dispatch|freight|courier|tracking",
  ],
  ["tShirt", "apparel|clothing|garment|outfit|size"],
  ["gavel", "auction|bid|bidding|lot"],
  [
    "handshake",
    "partner|partnership|contract|agreement|deal|affiliate|sponsor|sponsorship|negotiation",
  ],
  // Time and events.
  ["calendarCheck", "attendance|rsvp|checkin"],
  [
    "calendar",
    "event|booking|reservation|appointment|schedule|meeting|calendar|availability|slot|shift|holiday|leave|absence|vacation|date|occurrence|agenda|conference|concert",
  ],
  ["timer", "timer|countdown|stopwatch|timesheet|timeentry|duration"],
  ["hourglass", "expiry|expiration|deadline|ttl|trial|waitlist|waiting"],
  [
    "clockCounterClockwise",
    "version|revision|history|snapshot|backup|restore|undo|rollback",
  ],
  ["clock", "log|audit|activity|timeline|timestamp|time|trace|span|occurred"],
  // Messaging and alerts.
  ["bell", "notification|alert|reminder|push|notice|ping"],
  ["envelope", "email|mail|mailbox|inbox|outbox|mailinglist"],
  ["phone", "phone|call|voicemail|telephone|mobile|dial"],
  ["rss", "feed|rss|atom|syndication"],
  ["shareNetwork", "share|social|network|repost|retweet"],
  ["at", "handle|username|alias|nickname"],
  ["hash", "channel|counter|sequence|serial|identifier"],
  // Security and access.
  [
    "key",
    "session|token|apikey|key|secret|credential|password|passkey|otp|oauth|authenticator|totp|mfa|twofactor|jwt|nonce|signature",
  ],
  ["fingerprint", "device|biometric|fingerprint|webauthn"],
  ["signIn", "login|signin|logon|authentication|auth|sso"],
  ["shieldCheck", "consent|compliance|gdpr|privacy|verification|kyb"],
  [
    "shield",
    "role|permission|policy|access|security|guard|scope|grant|acl|rbac|privilege|ban|block",
  ],
  ["lock", "lock|encryption|vault|safe|lockout"],
  [
    "certificate",
    "certificate|license|licence|certification|diploma|accreditation|warranty",
  ],
  [
    "scales",
    "law|legal|case|court|lawsuit|claim|dispute|complaint|regulation|term|terms",
  ],
  // Settings and systems.
  [
    "gear",
    "setting|settings|config|configuration|preference|option|parameter|variable|env|environment|attribute|metadata|meta",
  ],
  [
    "flag",
    "flag|featureflag|feature|experiment|toggle|abuse|moderation|flagging",
  ],
  ["robot", "bot|ai|assistant|llm|prompt|completion|embedding|agent"],
  ["lightning", "webhook|trigger|hook|action|automation|rule|workflow"],
  [
    "plugs",
    "integration|connector|connection|provider|oauthapp|app|application",
  ],
  ["puzzlePiece", "plugin|extension|addon|module"],
  [
    "hardDrives",
    "server|host|node|instance|cluster|machine|database|db|shard|replica|region",
  ],
  [
    "cpu",
    "job|worker|cron|process|task|pipeline|run|execution|build|deployment|deploy|queue",
  ],
  ["database", "table|dataset|data|row|schema|migration|seed|import|export"],
  ["bug", "bug|issue|incident|error|exception|crash|defect|problem|outage"],
  ["checkSquare", "todo|checklist|step|requirement|assignment|chore"],
  [
    "kanban",
    "kanban|sprint|epic|backlog|milestone|roadmap|swimlane|column|stage|phase",
  ],
  [
    "briefcase",
    "project|career|position|opening|vacancy|opportunity|portfolio|work",
  ],
  [
    "chartBar",
    "report|analytic|analytics|metric|stat|statistic|kpi|dashboard|insight|usage|aggregate|summary",
  ],
  ["chartLine", "trend|forecast|timeseries|measurement|reading|sample"],
  ["target", "goal|objective|target|okr|aim|quota"],
  [
    "trophy",
    "achievement|award|leaderboard|trophy|medal|winner|championship|contest|competition|challenge",
  ],
  ["funnel", "filter|segment|funnel"],
  ["eye", "view|impression|pageview|visit|watch|seen|read|open"],
  ["cursorClick", "click|tap|interaction|conversion|engagement"],
  ["magnifyingGlass", "search|lookup|index|discovery"],
  ["archive", "archive|dump|retention|archived"],
  ["trash", "trash|deleted|tombstone|recycle|bin"],
  ["qrCode", "qr|qrcode|barcode|scan|scanner"],
  ["palette", "theme|color|colour|style|design|branding|appearance|skin"],
  // Organisations and places.
  [
    "buildings",
    "organization|organisation|org|company|business|workspace|enterprise|agency|firm|office|branch|institution|corporation|tenant",
  ],
  ["building", "building|venue|hotel|facility|site|campus"],
  [
    "house",
    "home|house|household|residence|listing|property|apartment|flat|rental|realestate",
  ],
  ["door", "room|unit|suite|door"],
  ["bed", "bed|stay|lodging|accommodation|night"],
  [
    "mapPin",
    "address|location|place|spot|poi|geo|geolocation|coordinate|stop|landmark",
  ],
  [
    "mapTrifold",
    "map|route|itinerary|trip|tour|journey|path|area|zone|territory",
  ],
  ["city", "city|town|municipality|district|neighborhood|neighbourhood"],
  [
    "globe",
    "country|nation|timezone|domain|website|web|world|continent|state|province",
  ],
  ["airplane", "flight|travel|airport|airline|airplane|plane"],
  ["car", "car|vehicle|ride|fleet|parking|garage"],
  // Life.
  ["forkKnife", "restaurant|menu|dish|meal|food|ingredient|cuisine|diet"],
  ["coffee", "cafe|coffee|drink|beverage|bar"],
  ["cookingPot", "cooking|kitchen|recipe"],
  ["pawPrint", "pet|animal|dog|cat|breed|species|vet"],
  ["plant", "plant|garden|tree|crop|farm|harvest|seedling"],
  ["cloudSun", "weather|climate|temperature"],
  ["gameController", "game|match|tournament|level|quest|round|gameplay"],
  ["barbell", "workout|exercise|fitness|training|gym|sport|sports"],
  ["baby", "baby|child|children|kid|kids|infant|family|parent"],
  [
    "graduationCap",
    "course|lesson|class|curriculum|enrollment|enrolment|school|university|college|exam|semester|degree|education|lecture",
  ],
  ["wrench", "maintenance|repair|service|workorder|fix|tool"],
  ["headphones", "support|helpdesk|ticketing|customerservice"],
  ["ticket", "ticket|pass|admission|seat"],
  ["television", "program|programme|tv"],
  ["deviceMobile", "install|installation|pushtoken"],
  ["paintBrush", "art|painting|drawing|creative"],
] as const satisfies readonly (readonly [string, string])[];

/** Every icon the studio may give a model, the table's own last. */
export type ModelIcon = (typeof ICON_RULES)[number][0] | "table";
export const MODEL_ICONS: readonly ModelIcon[] = [
  ...new Set<ModelIcon>([...ICON_RULES.map(([icon]) => icon), "table"]),
];

/** Each word, then the icon it calls for: the first rule that names it. */
const BY_WORD = new Map<string, ModelIcon>();
for (const [icon, words] of ICON_RULES) {
  for (const word of words.split("|")) {
    if (!BY_WORD.has(word)) BY_WORD.set(word, icon);
  }
}

const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;
/** A name's words, lower-cased: `blogPost`, `blog_posts`, `BlogPOSTS` → `blog`, `post(s)`. */
export function wordsOf(name: string): string[] {
  return (name.match(WORD) ?? []).map((word) => word.toLowerCase());
}

/** A word as written, then as each plural it may be of: `categories` → `category`, `boxes` → `box`. */
function readings(word: string): string[] {
  const out = [word];
  if (word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.endsWith("s")) out.push(word.slice(0, -1));
  return out;
}

const iconOfWord = (word: string): ModelIcon | undefined => {
  for (const reading of readings(word)) {
    const icon = BY_WORD.get(reading);
    if (icon) return icon;
  }
  return undefined;
};

/** The icon a name calls for: the whole name run together (`apiKey` → `apikey`), then each word, the last first. */
function iconOfName(name: string): ModelIcon | undefined {
  const words = wordsOf(name);
  const whole = iconOfWord(words.join(""));
  if (whole) return whole;
  for (const word of words.reverse()) {
    const icon = iconOfWord(word);
    if (icon) return icon;
  }
  return undefined;
}

/**
 * A row that only joins others: two or more rows it points to, and nothing of its own but its key and when it
 * was written.
 */
function isJunction(model: Omit<StudioModel, "icon">): boolean {
  const pointers = model.relations.filter(
    (relation) => relation.owner && relation.cardinality === "one"
  );
  const pointing = new Set(pointers.flatMap((relation) => relation.fields));
  return (
    pointers.length >= 2 &&
    model.fields.every(
      (field) =>
        pointing.has(field.name) ||
        field.generated !== undefined ||
        field.type === "datetime"
    )
  );
}

/** What a model's columns say it is, when its names say nothing. */
const BY_FIELDS: readonly (readonly [ModelIcon, readonly string[][]])[] = [
  [
    "user",
    [
      ["email", "password"],
      ["email", "passwordhash"],
      ["email", "hashedpassword"],
    ],
  ],
  [
    "mapPin",
    [
      ["latitude", "longitude"],
      ["lat", "lng"],
      ["lat", "lon"],
    ],
  ],
  ["calendar", [["startsat"], ["startat"], ["starttime"], ["endsat"]]],
  [
    "article",
    [
      ["title", "body"],
      ["title", "content"],
    ],
  ],
  ["currencyDollar", [["price"], ["amount"], ["total"]]],
  ["link", [["url"], ["href"]]],
];

function iconOfFields(model: Omit<StudioModel, "icon">): ModelIcon | undefined {
  const names = new Set(
    model.fields.map((field) => field.name.toLowerCase().replaceAll("_", ""))
  );
  return BY_FIELDS.find(([, sets]) =>
    sets.some((set) => set.every((name) => names.has(name)))
  )?.[0];
}

/**
 * The model's icon: its name's, else its table's; a row that only joins others, a link; else what its columns
 * say; else a table.
 */
export function guessIcon(model: Omit<StudioModel, "icon">): ModelIcon {
  return (
    iconOfName(model.name) ??
    iconOfName(model.table) ??
    (isJunction(model) ? "link" : undefined) ??
    iconOfFields(model) ??
    "table"
  );
}
