/**
 * An icon for each model, guessed from what it is called and, when its name says nothing, from its shape: the
 * studio shows a `user` as a person and an `invoice` as a receipt without the schema saying anything. The name is
 * read word by word (`blogPost`, `blog_posts` → `blog`, `post`), plural or singular, the last word first: it says
 * what the row is (`userProfile` is a profile), and words run together are read as one (`pull_requests`,
 * `api_keys`). A word that says only what kind of row it is (`OrderStatus`, `PasswordResetRequest`) lets a word
 * before it say more. A model whose name says nothing is read by its shape (a row joining two others, an email and
 * a password), else keeps the table icon. Measured on the schemas of open-source applications
 * (`test/fixtures/model-names.json`), more than nineteen names in twenty get an icon of their own.
 */

import type { StudioModel } from "./schema";

/** Each icon and the words that call for it, the first match winning. Icon names are entasis's (Phosphor). */
export const ICON_RULES = [
  [
    "link",
    "link|url|redirect|shortlink|permalink|join|junction|pivot|slug|reference|mapping|association|previewcard|binding|dependency|linkset|relation",
  ],
  ["userCircle", "profile|avatar|bio|persona"],
  [
    "users",
    "member|membership|follower|following|follow|friend|friendship|subscriber|attendee|participant|collaborator|contributor|assignee|relationship|kin",
  ],
  ["usersThree", "team|group|community|squad|club|crew|cohort|guild|circle"],
  ["userPlus", "invitation|invite|referral|signup|registration|onboarding"],
  ["addressBook", "contact|lead|prospect|directory|phonebook"],
  ["identificationCard", "identity|kyc|passport|idcard|ownership"],
  ["student", "student|learner|pupil|alumnus|alumni"],
  ["chalkboardTeacher", "teacher|instructor|tutor|mentor|coach|classroom"],
  ["stethoscope", "doctor|physician|clinic|hospital|practitioner|nurse"],
  ["heartbeat", "patient|health|vital|symptom|diagnosis|medical|monitor"],
  ["pill", "medication|medicine|prescription|drug|pill|dose|pharmacy"],
  [
    "user",
    "user|account|customer|client|person|people|author|owner|admin|administrator|staff|employee|player|creator|visitor|guest|buyer|operator|actor|individual|human|resident|driver|rider|passenger|candidate|applicant|volunteer|speaker|organizer|moderator|editor|reviewer|approver|signer|recipient|sender|subject|beneficiary|principal|holder|signatory|manager|submitter|traveller|traveler",
  ],
  [
    "newspaper",
    "news|newsletter|press|digest|bulletin|headline|magazine|clipping",
  ],
  [
    "article",
    "post|article|blog|story|entry|page|content|essay|publication|writeup|contentblock|pageblock",
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
  ["chatText", "message|chat|conversation|dm|text|sms|tweet|toot|chirp"],
  ["chatsCircle", "chatroom|forum|debate"],
  ["quotes", "testimonial|citation|excerpt"],
  ["question", "question|faq|inquiry|enquiry|poll|quiz|reason"],
  ["clipboardText", "survey|form|questionnaire|submission|result"],
  [
    "megaphone",
    "announcement|campaign|broadcast|ad|advert|advertisement|promotion|promo|publisher",
  ],
  ["tag", "tag|label|keyword|hashtag|topic|tagging|term"],
  [
    "folder",
    "category|folder|section|genre|subcategory|taxonomy|classification|department|namespace|space|taxon",
  ],
  ["textbox", "field|customfield|formfield"],
  ["terminalWindow", "command|console|shell|cli"],
  ["listChecks", "choice"],
  ["brain", "memory|knowledgegraph"],
  ["layout", "layout"],
  ["listBullets", "menu|navigation|nav|sidebar|breadcrumb|tab"],
  [
    "stack",
    "collection|list|playlist|bundle|set|board|stack|batch|series|catalog|catalogue|library|shelf|lineup",
  ],
  [
    "image",
    "image|photo|picture|gallery|media|thumbnail|banner|cover|logo|icon|illustration|artwork|screenshot|sticker|poster",
  ],
  [
    "videoCamera",
    "video|clip|livestream|movie|film|episode|recording|webinar|reel|show",
  ],
  ["musicNote", "song|track|music|album|audio|podcast|sound|artist|band|lyric"],
  ["microphone", "voice|speech|transcript|transcription|dictation"],
  ["paperclip", "attachment|upload"],
  ["file", "file|document|blob|object|resource|asset|binary|pdf|download"],
  [
    "code",
    "code|snippet|script|gist|function|query|macro|template|component|widget|shortcode|embed|liquid|regex|expression",
  ],
  ["translate", "translation|i18n|localization|locale|language|dictionary"],
  ["bookmark", "bookmark|saved|save|pin|readlater|marker"],
  ["heart", "like|favorite|favourite|reaction|wishlist|love|kudos|clap"],
  [
    "thumbsUp",
    "vote|upvote|downvote|endorsement|approval|recommendation|votation|ballot|stance",
  ],
  ["star", "review|rating|star|score|grade|ranking|rank"],
  ["smiley", "emoji|mood|sentiment|emotion"],
  ["shoppingCart", "cart|basket|checkout|order|purchase|sale|preorder"],
  [
    "receipt",
    "invoice|bill|billing|receipt|lineitem|orderline|estimate|quotation|statement|quote|orderitem|cartitem|invoiceitem",
  ],
  [
    "creditCard",
    "payment|charge|card|transaction|transfer|payout|refund|chargeback|paymentmethod|settlement|creditcard|debitcard|bankcard",
  ],
  ["percent", "discount|coupon|voucher|rebate|tax|vat"],
  ["coins", "credit|coin|point|reward|loyalty|cashback|balance"],
  ["piggyBank", "saving|savings|deposit|fund"],
  [
    "money",
    "revenue|income|expense|budget|salary|payroll|donation|tip|fee|cost|spend|commission|earning|proration|interest|dividend|cashflow",
  ],
  ["wallet", "wallet|purse"],
  [
    "bank",
    "bank|ledger|treasury|bankaccount|iban|loan|mortgage|depository|brokerage|custodian",
  ],
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
    "product|item|sku|inventory|good|goods|merchandise|parcel|package|variant|carton|pack|registry|crate|container|upstream|stock|artifact|gem|rubygem",
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
    "partner|partnership|contract|agreement|deal|affiliate|sponsor|sponsorship|negotiation|commitment",
  ],
  ["calendarCheck", "attendance|rsvp|checkin"],
  [
    "calendar",
    "event|booking|reservation|appointment|schedule|meeting|calendar|availability|slot|shift|holiday|leave|absence|vacation|date|occurrence|agenda|conference|concert|period|season|weekday|day|month|year",
  ],
  [
    "timer",
    "timer|countdown|stopwatch|timesheet|timeentry|duration|sla|timelog|responsetime",
  ],
  [
    "hourglass",
    "expiry|expiration|deadline|ttl|trial|waitlist|waiting|waitpoint|pending|delay|cooldown",
  ],
  [
    "clockCounterClockwise",
    "version|revision|history|snapshot|backup|restore|undo|rollback|changelog",
  ],
  [
    "clock",
    "log|audit|activity|timeline|timestamp|time|trace|span|occurred|hour|workinghour|uptime|interval|auditevent",
  ],
  ["bell", "notification|alert|reminder|push|notice|ping"],
  ["envelope", "email|mail|mailbox|inbox|outbox|mailinglist|envelope"],
  [
    "phone",
    "phone|call|voicemail|telephone|mobile|dial|phonenumber|verifiednumber|number",
  ],
  ["rss", "feed|rss|atom|syndication"],
  [
    "shareNetwork",
    "share|social|network|repost|retweet|boost|relay|reblog|federation|fediverse",
  ],
  ["at", "handle|username|alias|nickname"],
  [
    "hash",
    "channel|counter|sequence|serial|identifier|id|uid|uuid|idempotency",
  ],
  [
    "key",
    "session|token|apikey|key|secret|credential|password|passkey|otp|oauth|authenticator|totp|mfa|twofactor|jwt|nonce|signature|jwks|jwk|keystore|keypair|lease|mfachallenge|backupcode|recoverycode|authorizationcode|otpcode|kms|signing",
  ],
  ["fingerprint", "device|biometric|fingerprint|webauthn"],
  ["signIn", "login|signin|logon|authentication|auth|sso"],
  ["shieldCheck", "consent|compliance|gdpr|privacy|verification|kyb"],
  [
    "shield",
    "role|permission|policy|access|security|guard|scope|grant|acl|rbac|privilege|ban|block|restriction|banned|isolation|firewall|allowlist|blocklist|denylist|scoping|entitlement",
  ],
  ["lock", "lock|encryption|vault|safe|lockout"],
  [
    "certificate",
    "certificate|license|licence|certification|diploma|accreditation|warranty|issuer|x509|ca",
  ],
  [
    "scales",
    "law|legal|case|court|lawsuit|claim|dispute|complaint|regulation|appeal|arbitration|verdict|reconciliation|termsofservice|termsandconditions|tos|termsofuse",
  ],
  [
    "gear",
    "setting|settings|config|configuration|preference|option|parameter|variable|env|environment|attribute|metadata|meta|property",
  ],
  [
    "flag",
    "flag|featureflag|feature|experiment|toggle|abuse|moderation|flagging|gate|flipper",
  ],
  [
    "robot",
    "bot|ai|assistant|llm|prompt|completion|embedding|agent|model|mlmodel|typebot|toolcall|functioncall|promptblock|machinelearning",
  ],
  [
    "lightning",
    "webhook|trigger|hook|action|automation|rule|workflow|callback|listener|handler|signal",
  ],
  [
    "plugs",
    "integration|connector|connection|provider|oauthapp|app|application|oauthclient|endpoint|source|gateway",
  ],
  ["puzzlePiece", "plugin|extension|addon|module|capability|ability"],
  [
    "hardDrives",
    "server|host|node|instance|cluster|machine|database|db|shard|replica|region|cache",
  ],
  [
    "cpu",
    "job|worker|cron|process|task|run|execution|build|deployment|deploy|queue|workload|runner|controller",
  ],
  [
    "database",
    "table|dataset|data|row|schema|migration|seed|import|export|partition|corpus|datastore|kvstore|keyvaluestore",
  ],
  [
    "bug",
    "bug|issue|incident|error|exception|crash|defect|problem|outage|errorgroup",
  ],
  [
    "checkSquare",
    "todo|checklist|step|requirement|assignment|chore|check|subtask|acceptance",
  ],
  [
    "kanban",
    "kanban|sprint|epic|backlog|milestone|roadmap|swimlane|column|stage|phase",
  ],
  [
    "briefcase",
    "project|career|opening|vacancy|opportunity|portfolio|work|position",
  ],
  [
    "chartBar",
    "report|analytic|analytics|metric|stat|statistic|kpi|dashboard|insight|usage|aggregate|summary|census|aggregation",
  ],
  ["chartLine", "trend|forecast|timeseries|measurement|reading|sample"],
  ["target", "goal|objective|target|okr|aim|quota|outcome|strategy"],
  [
    "trophy",
    "achievement|award|leaderboard|trophy|medal|winner|championship|contest|competition|challenge|badge",
  ],
  ["funnel", "filter|segment|funnel|condition"],
  [
    "eye",
    "view|impression|pageview|visit|watch|seen|read|open|watchlist|viewer|pixel|watcher|observer",
  ],
  ["cursorClick", "click|tap|interaction|conversion|engagement"],
  [
    "magnifyingGlass",
    "search|lookup|index|discovery|indices|indexing|reindexing|crawl|crawler|finding",
  ],
  ["archive", "archive|dump|retention|archived|bucket|blobstore"],
  ["trash", "trash|deleted|tombstone|recycle|bin|deletion|removal|purge"],
  ["qrCode", "qr|qrcode|barcode|scan|scanner"],
  ["palette", "theme|color|colour|style|design|branding|skin"],
  [
    "buildings",
    "organization|organisation|org|company|business|workspace|enterprise|agency|firm|office|branch|institution|corporation|tenant",
  ],
  ["building", "building|venue|hotel|facility|campus"],
  [
    "house",
    "home|house|household|residence|listing|apartment|flat|rental|realestate|estate",
  ],
  ["door", "room|suite|door"],
  ["bed", "bed|stay|lodging|accommodation|night"],
  [
    "mapPin",
    "address|location|place|spot|poi|geo|geolocation|coordinate|stop|landmark|destination",
  ],
  [
    "mapTrifold",
    "map|route|itinerary|trip|tour|journey|path|area|zone|territory|geozone",
  ],
  ["city", "city|town|municipality|district|neighborhood|neighbourhood"],
  [
    "globe",
    "country|nation|timezone|domain|website|web|world|continent|state|province|portal|origin|ip|subdomain|hostname|site|geoip",
  ],
  ["airplane", "flight|travel|airport|airline|airplane|plane"],
  ["car", "car|vehicle|ride|fleet|parking|garage"],
  ["forkKnife", "restaurant|dish|meal|food|ingredient|cuisine|diet"],
  ["coffee", "cafe|coffee|drink|beverage"],
  ["cookingPot", "cooking|kitchen|recipe"],
  ["pawPrint", "pet|animal|dog|cat|breed|species|vet"],
  ["plant", "plant|garden|tree|crop|farm|harvest|seedling"],
  ["cloudSun", "weather|climate|temperature"],
  ["gameController", "game|match|tournament|level|quest|round|gameplay"],
  ["barbell", "workout|exercise|fitness|gym|sport|sports"],
  ["baby", "baby|child|children|kid|kids|infant|family|parent"],
  [
    "graduationCap",
    "course|lesson|class|curriculum|enrollment|enrolment|school|university|college|exam|semester|degree|education|lecture|training",
  ],
  ["wrench", "maintenance|repair|service|workorder|fix|tool|remediation"],
  ["headphones", "support|helpdesk|ticketing|customerservice"],
  ["ticket", "ticket|pass|admission|seat"],
  ["television", "program|programme|tv"],
  ["deviceMobile", "install|installation|pushtoken"],
  ["paintBrush", "art|painting|drawing|creative"],
  ["gitPullRequest", "pullrequest|mergerequest|diff|patch|mergetrain"],
  ["gitCommit", "commit|changeset"],
  ["gitBranch", "repo|repository|ref|fork"],
  ["copy", "mirror|duplicate|clone|copy"],
  [
    "flask",
    "evaluator|evaluation|eval|benchmark|test|assay|lab|valuator|scorer",
  ],
  ["crown", "premium|vip|hat|elite"],
  ["sparkle", "skill|enrichment|highlight|spotlight|magic"],
  ["lightbulb", "concept|idea|suggestion|hint|proposal|brainstorm"],
  ["pencilSimple", "edit|editing|change|correction|amendment"],
  ["speakerSlash", "mute|silence"],
  ["info", "status|detail|info|information|about"],
  [
    "arrowsClockwise",
    "sync|synchronization|update|refresh|recurrence|renewal|retry|iteration|cadence",
  ],
  ["arrowsLeftRight", "trade|exchange|swap|barter|datatransfer"],
  ["chartPie", "holding|allocation|portion|split|slice|breakdown"],
  ["chartLineUp", "investment|valuation|growth|performance|securities"],
  ["arrowUUpLeft", "return|rma"],
  ["slidersHorizontal", "adjustment|calibration|tuning|control"],
  ["calculator", "calculator|calculation|formula|computation"],
  ["flagCheckered", "checkpoint|finish|finishline"],
  [
    "flowArrow",
    "flow|edge|transition|scenario|branching|stream|valuestream|pipeline",
  ],
  [
    "treeStructure",
    "hierarchy|descendant|ancestor|lineage|closure|nesting|structure",
  ],
  ["rocket", "release|launch|rollout|liftoff"],
  [
    "shieldWarning",
    "vulnerability|advisory|cve|malware|threat|risk|severity|exposure",
  ],
  ["gauge", "limit|throttle|ratelimit|capacity|threshold|progress|progressbar"],
  ["paperPlaneTilt", "request|sent|send|outgoing"],
  ["warning", "deprecation|warning|caution|violation|strike|infraction"],
  ["textT", "title|heading|caption|typography|font"],
  ["sealCheck", "attestation|seal|notarization|proof"],
  ["handCoins", "reimbursement|stipend|allowance|liability|debt"],
  ["currencyBtc", "crypto|bitcoin|blockchain|nft"],
  [
    "fileText",
    "manifest|evidence|sbom|spec|specification|readme|paper|markdown",
  ],
  ["cube", "prototype|blueprint|entity"],
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

/** Endings a word is run into that say what it is: `postmeta` is metadata, `typebot` a bot. */
const ENDINGS = ["meta", "bot"];

/**
 * A word as written, then as each plural it may be of (`categories` → `category`, `boxes` → `box`), then the
 * ending it was run into.
 */
function readings(word: string): string[] {
  const out = [word];
  if (word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("s")) out.push(word.slice(0, -1));
  if (word.endsWith("es")) out.push(word.slice(0, -2));
  for (const ending of ENDINGS) {
    if (
      word.length > ending.length &&
      out.some((reading) => reading.endsWith(ending))
    )
      out.push(ending);
  }
  return out;
}

const iconOfWord = (word: string): ModelIcon | undefined => {
  for (const reading of readings(word)) {
    const icon = BY_WORD.get(reading);
    if (icon) return icon;
  }
  return undefined;
};

/**
 * Words that say what kind of row it is but not what about (`OrderStatus`, `PasswordResetRequest`, `EventData`):
 * a word before them that says more wins, else they still give the icon.
 */
const GENERIC = new Set<string>([
  "request",
  "detail",
  "info",
  "information",
  "data",
  "record",
  "entry",
  "status",
  "update",
  "change",
  "edit",
  "attempt",
  "result",
  "reference",
  "mapping",
  "association",
  "number",
  "check",
  "test",
  "item",
  "type",
  "kind",
  "state",
  "store",
  "storage",
  "call",
  "code",
  "delivery",
  "subscription",
  "relationship",
  "completion",
  "listing",
  "level",
  "position",
  "card",
  "challenge",
]);
const isGeneric = (word: string) =>
  readings(word).some((reading) => GENERIC.has(reading));

/**
 * The icon a name calls for, its last words first: the last three run together, then the last two, then the last
 * one (`merge_request_diff` → `diff`, `pull_requests` → `pullrequest`, `api_keys` → `apikey`), then the same from
 * the word before. A generic word's icon (`status`) waits for a word before it that says more (`order`).
 */
function iconOfName(name: string): ModelIcon | undefined {
  const words = wordsOf(name);
  let generic: ModelIcon | undefined;
  for (let end = words.length; end > 0; end -= 1) {
    for (let span = Math.min(3, end); span >= 1; span -= 1) {
      const icon = iconOfWord(words.slice(end - span, end).join(""));
      if (!icon) continue;
      if (span > 1 || !isGeneric(words[end - 1]!)) return icon;
      generic ??= icon;
      break;
    }
  }
  return generic;
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
