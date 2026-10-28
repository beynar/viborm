import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  guessIcon,
  ICON_RULES,
  MODEL_ICONS,
  type ModelIcon,
  wordsOf,
} from "../src/icons";
import type { StudioField, StudioModel, StudioRelation } from "../src/schema";

const LOWER_WORD = /^[a-z0-9]+$/;
const ENTASIS_ICONS = join(
  import.meta.dirname,
  "../node_modules/entasis/dist/components/Icons"
);

const field = (
  name: string,
  extra: Partial<StudioField> = {}
): StudioField => ({
  name,
  column: name,
  type: "string",
  nullable: false,
  list: false,
  id: false,
  unique: false,
  searchable: true,
  optional: false,
  updatable: true,
  ...extra,
});

const pointer = (name: string, fields: string[]): StudioRelation => ({
  name,
  cardinality: "one",
  targets: [name],
  storage: "foreignKey",
  owner: true,
  fields,
  references: ["id"],
});

const model = (
  name: string,
  shape: Partial<Omit<StudioModel, "icon" | "name">> = {}
): Omit<StudioModel, "icon"> => ({
  name,
  table: name,
  fields: [field("id", { id: true, type: "int", generated: "increment" })],
  relations: [],
  ...shape,
});

/** Names as schemas write them, and the icon each should get. */
const NAMED: readonly (readonly [string, ModelIcon])[] = [
  // People and accounts.
  ["user", "user"],
  ["User", "user"],
  ["users", "user"],
  ["AppUser", "user"],
  ["account", "user"],
  ["customer", "user"],
  ["Customers", "user"],
  ["client", "user"],
  ["person", "user"],
  ["people", "user"],
  ["author", "user"],
  ["employee", "user"],
  ["staffMember", "users"],
  ["teamMember", "users"],
  ["member", "users"],
  ["membership", "users"],
  ["follower", "users"],
  ["friendship", "users"],
  ["subscriber", "users"],
  ["team", "usersThree"],
  ["teams", "usersThree"],
  ["user_groups", "usersThree"],
  ["community", "usersThree"],
  ["profile", "userCircle"],
  ["userProfile", "userCircle"],
  ["user_profiles", "userCircle"],
  ["avatar", "userCircle"],
  ["invitation", "userPlus"],
  ["TeamInvite", "userPlus"],
  ["referral", "userPlus"],
  ["contact", "addressBook"],
  ["lead", "addressBook"],
  ["student", "student"],
  ["teacher", "chalkboardTeacher"],
  ["doctor", "stethoscope"],
  ["patient", "heartbeat"],
  ["prescription", "pill"],
  // Writing and media.
  ["post", "article"],
  ["posts", "article"],
  ["BlogPost", "article"],
  ["blog_posts", "article"],
  ["article", "article"],
  ["page", "article"],
  ["story", "article"],
  ["newsletter", "newspaper"],
  ["news", "newspaper"],
  ["note", "note"],
  ["draft", "note"],
  ["journal", "notebook"],
  ["book", "bookOpen"],
  ["chapter", "bookOpen"],
  ["wiki_pages", "article"],
  ["documentation", "bookOpen"],
  ["comment", "chatCircle"],
  ["comments", "chatCircle"],
  ["PostComment", "chatCircle"],
  ["reply", "chatCircle"],
  ["replies", "chatCircle"],
  ["feedback", "chatCircle"],
  ["message", "chatText"],
  ["ChatMessage", "chatText"],
  ["conversation", "chatText"],
  ["testimonial", "quotes"],
  ["question", "question"],
  ["faq", "question"],
  ["survey", "clipboardText"],
  ["form_submissions", "clipboardText"],
  ["announcement", "megaphone"],
  ["campaign", "megaphone"],
  ["tag", "tag"],
  ["tags", "tag"],
  ["label", "tag"],
  ["category", "folder"],
  ["categories", "folder"],
  ["ProductCategory", "folder"],
  ["folder", "folder"],
  ["collection", "stack"],
  ["playlist", "stack"],
  ["board", "stack"],
  ["image", "image"],
  ["images", "image"],
  ["ProductImage", "image"],
  ["photo", "image"],
  ["media", "image"],
  ["video", "videoCamera"],
  ["episode", "videoCamera"],
  ["song", "musicNote"],
  ["podcast", "musicNote"],
  ["transcript", "microphone"],
  ["attachment", "paperclip"],
  ["file", "file"],
  ["files", "file"],
  ["document", "file"],
  ["asset", "file"],
  ["snippet", "code"],
  ["template", "code"],
  ["savedQuery", "code"],
  ["translation", "translate"],
  ["locale", "translate"],
  ["bookmark", "bookmark"],
  ["like", "heart"],
  ["PostLike", "heart"],
  ["favorite", "heart"],
  ["reaction", "heart"],
  ["vote", "thumbsUp"],
  ["review", "star"],
  ["ProductReview", "star"],
  ["rating", "star"],
  // Commerce.
  ["order", "shoppingCart"],
  ["orders", "shoppingCart"],
  ["cart", "shoppingCart"],
  ["purchase", "shoppingCart"],
  ["OrderItem", "receipt"],
  ["order_items", "receipt"],
  ["lineItem", "receipt"],
  ["invoice", "receipt"],
  ["invoices", "receipt"],
  ["quote", "receipt"],
  ["payment", "creditCard"],
  ["transaction", "creditCard"],
  ["refund", "creditCard"],
  ["PaymentMethod", "creditCard"],
  ["creditCard", "creditCard"],
  ["coupon", "percent"],
  ["discount", "percent"],
  ["tax_rates", "currencyDollar"],
  ["loyaltyPoints", "coins"],
  ["reward", "coins"],
  ["credit", "coins"],
  ["expense", "money"],
  ["donation", "money"],
  ["wallet", "wallet"],
  ["ledger", "bank"],
  ["bankAccount", "bank"],
  ["price", "currencyDollar"],
  ["plan", "currencyDollar"],
  ["subscription", "currencyDollar"],
  ["giftCard", "gift"],
  ["shop", "storefront"],
  ["store", "storefront"],
  ["vendor", "storefront"],
  ["seller", "storefront"],
  ["brand", "storefront"],
  ["product", "package"],
  ["products", "package"],
  ["ProductVariant", "package"],
  ["inventory", "package"],
  ["item", "package"],
  ["warehouse", "warehouse"],
  ["shipment", "truck"],
  ["delivery", "truck"],
  ["deliveries", "truck"],
  ["auction", "gavel"],
  ["bid", "gavel"],
  ["contract", "handshake"],
  ["deal", "handshake"],
  ["partner", "handshake"],
  // Time and events.
  ["attendance", "calendarCheck"],
  ["rsvp", "calendarCheck"],
  ["event", "calendar"],
  ["events", "calendar"],
  ["booking", "calendar"],
  ["reservation", "calendar"],
  ["appointment", "calendar"],
  ["meeting", "calendar"],
  ["shift", "calendar"],
  ["timesheet", "timer"],
  ["TimeEntry", "timer"],
  ["deadline", "hourglass"],
  ["waitlist", "hourglass"],
  ["version", "clockCounterClockwise"],
  ["revision", "clockCounterClockwise"],
  ["PostRevision", "clockCounterClockwise"],
  ["log", "clock"],
  ["AuditLog", "clock"],
  ["audit_logs", "clock"],
  ["activity", "clock"],
  ["history", "clockCounterClockwise"],
  // Messaging.
  ["notification", "bell"],
  ["notifications", "bell"],
  ["reminder", "bell"],
  ["email", "envelope"],
  ["emails", "envelope"],
  ["mailbox", "envelope"],
  ["inbox", "envelope"],
  ["phone", "phone"],
  ["PhoneNumber", "phone"],
  ["feed", "rss"],
  ["share", "shareNetwork"],
  ["channel", "hash"],
  ["username", "at"],
  // Security.
  ["session", "key"],
  ["sessions", "key"],
  ["apiKey", "key"],
  ["api_keys", "key"],
  ["accessToken", "key"],
  ["refresh_tokens", "key"],
  ["password", "key"],
  ["PasswordResetToken", "key"],
  ["VerificationToken", "key"],
  ["credential", "key"],
  ["device", "fingerprint"],
  ["login", "signIn"],
  ["consent", "shieldCheck"],
  ["EmailVerification", "shieldCheck"],
  ["role", "shield"],
  ["roles", "shield"],
  ["UserRole", "shield"],
  ["permission", "shield"],
  ["policy", "shield"],
  ["policies", "shield"],
  ["license", "certificate"],
  ["certificate", "certificate"],
  ["dispute", "scales"],
  // Systems.
  ["setting", "gear"],
  ["settings", "gear"],
  ["UserSettings", "gear"],
  ["preference", "gear"],
  ["config", "gear"],
  ["featureFlag", "flag"],
  ["feature_flags", "flag"],
  ["experiment", "flag"],
  ["bot", "robot"],
  ["agent", "robot"],
  ["prompt", "robot"],
  ["embedding", "robot"],
  ["webhook", "lightning"],
  ["WebhookEvent", "calendar"],
  ["trigger", "lightning"],
  ["workflow", "lightning"],
  ["integration", "plugs"],
  ["connection", "plugs"],
  ["OAuthApplication", "plugs"],
  ["plugin", "puzzlePiece"],
  ["server", "hardDrives"],
  ["cluster", "hardDrives"],
  ["region", "hardDrives"],
  ["job", "cpu"],
  ["jobs", "cpu"],
  ["BackgroundJob", "cpu"],
  ["task", "cpu"],
  ["deployment", "cpu"],
  ["migration", "database"],
  ["dataset", "database"],
  ["issue", "bug"],
  ["incident", "bug"],
  ["todo", "checkSquare"],
  ["checklist", "checkSquare"],
  ["sprint", "kanban"],
  ["milestone", "kanban"],
  ["project", "briefcase"],
  ["projects", "briefcase"],
  ["position", "briefcase"],
  ["report", "chartBar"],
  ["metric", "chartBar"],
  ["DailyStats", "chartBar"],
  ["measurement", "chartLine"],
  ["goal", "target"],
  ["achievement", "trophy"],
  ["leaderboard", "trophy"],
  ["segment", "funnel"],
  ["PageView", "eye"],
  ["page_views", "eye"],
  ["impression", "eye"],
  ["click", "cursorClick"],
  ["search", "magnifyingGlass"],
  ["archive", "archive"],
  ["theme", "palette"],
  // Places and organisations.
  ["organization", "buildings"],
  ["organisation", "buildings"],
  ["org", "buildings"],
  ["company", "buildings"],
  ["companies", "buildings"],
  ["tenant", "buildings"],
  ["workspace", "buildings"],
  ["building", "building"],
  ["venue", "building"],
  ["listing", "house"],
  ["property", "gear"],
  ["properties", "gear"],
  ["room", "door"],
  ["address", "mapPin"],
  ["addresses", "mapPin"],
  ["ShippingAddress", "mapPin"],
  ["location", "mapPin"],
  ["place", "mapPin"],
  ["route", "mapTrifold"],
  ["trip", "mapTrifold"],
  ["city", "city"],
  ["cities", "city"],
  ["country", "globe"],
  ["countries", "globe"],
  ["timezone", "globe"],
  ["flight", "airplane"],
  ["vehicle", "car"],
  // Life.
  ["restaurant", "forkKnife"],
  ["menu", "listBullets"],
  ["recipe", "cookingPot"],
  ["recipes", "cookingPot"],
  ["pet", "pawPrint"],
  ["plant", "plant"],
  ["weather", "cloudSun"],
  ["game", "gameController"],
  ["workout", "barbell"],
  ["child", "baby"],
  ["course", "graduationCap"],
  ["lesson", "graduationCap"],
  ["enrollment", "graduationCap"],
  ["classes", "graduationCap"],
  ["maintenance", "wrench"],
  ["support_tickets", "ticket"],
  ["ticket", "ticket"],
  ["seat", "ticket"],
  // A word before a generic one says more; words run together are read as one.
  ["OrderStatus", "shoppingCart"],
  ["PasswordResetRequest", "key"],
  ["EventData", "calendar"],
  ["TransactionItem", "creditCard"],
  ["SecretStore", "key"],
  ["spree_stores", "storefront"],
  ["push_subscriptions", "bell"],
  ["Subscription", "currencyDollar"],
  ["WebhookDelivery", "lightning"],
  ["preview_cards", "link"],
  ["credit_cards", "creditCard"],
  ["widget_cards", "code"],
  ["tool_calls", "robot"],
  ["VoucherCode", "percent"],
  ["TwoFactorBackupCode", "key"],
  ["OAuthClient", "plugs"],
  ["otp_challenges", "key"],
  ["pull_requests", "gitPullRequest"],
  ["merge_request_diffs", "gitPullRequest"],
  ["phone_numbers", "phone"],
  ["terms_of_services", "scales"],
  ["wp_terms", "tag"],
  ["wp_postmeta", "gear"],
  ["Typebot", "robot"],
  ["spree_states", "globe"],
  ["flow_state", "flowArrow"],
  ["securities", "chartLineUp"],
  ["progress_bars", "gauge"],
  ["survey_completions", "clipboardText"],
  ["diff_note_positions", "note"],
  ["access_levels", "shield"],
  ["github_repositories", "gitBranch"],
  ["vulnerabilities", "shieldWarning"],
  ["ml_models", "robot"],
  ["releases", "rocket"],
  ["holdings", "chartPie"],
];

test.each(NAMED)("%s → %s", (name, icon) => {
  expect(guessIcon(model(name))).toBe(icon);
});

test("the table's name speaks when the model's does not", () => {
  expect(guessIcon(model("Thing", { table: "invoices" }))).toBe("receipt");
});

test("a row that only joins two others is a link", () => {
  const joining = model("AbCd", {
    fields: [
      field("postId", { type: "int" }),
      field("thingId", { type: "int" }),
      field("assignedAt", { type: "datetime" }),
    ],
    relations: [pointer("post", ["postId"]), pointer("thing", ["thingId"])],
  });
  expect(guessIcon(joining)).toBe("link");
  // A column of its own makes it more than a join.
  expect(
    guessIcon({ ...joining, fields: [...joining.fields, field("note2")] })
  ).toBe("table");
  // One pointer does not join.
  expect(
    guessIcon({ ...joining, relations: joining.relations.slice(0, 1) })
  ).toBe("table");
});

test("columns speak when the names say nothing", () => {
  const withFields = (...names: string[]) =>
    guessIcon(model("Thing", { fields: names.map((name) => field(name)) }));
  expect(withFields("email", "passwordHash")).toBe("user");
  expect(withFields("email", "password_hash")).toBe("user");
  expect(withFields("latitude", "longitude")).toBe("mapPin");
  expect(withFields("startsAt")).toBe("calendar");
  expect(withFields("title", "body")).toBe("article");
  expect(withFields("amount")).toBe("currencyDollar");
  expect(withFields("url")).toBe("link");
  expect(withFields("email")).toBe("table");
});

test("a name that says nothing keeps the table icon", () => {
  expect(guessIcon(model("Thing"))).toBe("table");
  expect(guessIcon(model("xyz_42"))).toBe("table");
  expect(guessIcon(model("_"))).toBe("table");
});

test("names are read word by word, whatever their case", () => {
  expect(wordsOf("blogPost")).toEqual(["blog", "post"]);
  expect(wordsOf("blog_posts")).toEqual(["blog", "posts"]);
  expect(wordsOf("APIKey")).toEqual(["api", "key"]);
  expect(wordsOf("OAuth2Client")).toEqual(["o", "auth", "2", "client"]);
  expect(wordsOf("page-views")).toEqual(["page", "views"]);
  expect(wordsOf("__")).toEqual([]);
});

test("every icon is one entasis ships, and every word calls for one icon", () => {
  for (const icon of MODEL_ICONS) {
    expect(existsSync(join(ENTASIS_ICONS, `${icon}.js`)), icon).toBe(true);
  }
  const seen = new Map<string, string>();
  for (const [icon, words] of ICON_RULES) {
    for (const word of words.split("|")) {
      expect(seen.get(word), `${word}: ${seen.get(word)} and ${icon}`).toBe(
        undefined
      );
      expect(word).toMatch(LOWER_WORD);
      seen.set(word, icon);
    }
  }
  expect(seen.size).toBeGreaterThan(900);
});

/**
 * The model and table names of open-source applications' schemas (Cal.com, Mastodon, Forem, Chatwoot, Documenso,
 * Langfuse, Trigger.dev, Saleor, Solidus, Maybe, Consul, Loomio, Lago, Open Food Network, RubyGems.org, …), as
 * their own schema files spell them: what the studio meets in the wild. Ninety-five in a hundred, at least, get
 * an icon of their own rather than the table's.
 */
test("names from real schemas get an icon of their own", async () => {
  const { default: sources } = await import("./fixtures/model-names.json", {
    with: { type: "json" },
  });
  let named = 0;
  let total = 0;
  const left: string[] = [];
  for (const names of Object.values(sources)) {
    for (const name of names) {
      total += 1;
      if (guessIcon(model(name)) === "table") left.push(name);
      else named += 1;
    }
  }
  expect(total).toBeGreaterThan(2000);
  expect(named / total, left.join(", ")).toBeGreaterThanOrEqual(0.95);
});
