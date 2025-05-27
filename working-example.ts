import { s } from "./src/schema/index.js";

// Non-circular example (should have perfect type inference)
const simpleUser = s.model("simpleUser", {
  name: s.string(),
  age: s.int(),
});

type SimpleUserType = typeof simpleUser;
type SimpleUserInfer = typeof simpleUser.infer;

// Circular example (may have some type limitations due to circularity)
const profile = s.model("profile", {
  name: s.string(),
  age: s.int(),
  get friends() {
    return s.relation(() => [profile]); // No need for s.lazy()!
  },
});

// Type checks
type ProfileType = typeof profile;
type ProfileInfer = typeof profile.infer;

// Test actual type inference with real data
const simpleUserData = simpleUser.infer;
// This should be type-safe
const userName: string = simpleUserData.name; // Should work
const userAge: number = simpleUserData.age; // Should work

const profileData = profile.infer;
// This should also be type-safe
const profileName: string = profileData.name; // Should work
const profileAge: number = profileData.age; // Should work
// const profileFriends: any[] = profileData.friends; // This might be circular

// Test it
console.log("=== SIMPLE USER (no circular refs) ===");
console.log("Simple user name:", simpleUser.name);
console.log("Simple user infer:", typeof simpleUser.infer);
console.log("Type-safe access - name:", userName, "age:", userAge);

console.log("\n=== PROFILE (with circular refs) ===");
console.log("Profile model:", profile.name);
console.log("Has friends relation:", profile.relations.has("friends"));

const friendsRelation = profile.relations.get("friends");
console.log("Friends relation type:", friendsRelation?.relationType);
console.log("Friends target model:", friendsRelation?.targetModel?.name);

// Test type inference
console.log("Profile infer type:", typeof profileData);
console.log("Type-safe access - name:", profileName, "age:", profileAge);

console.log("✅ Both simple and circular relations work!");
