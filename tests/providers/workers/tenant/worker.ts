export default {
  fetch(): Response {
    return new Response("VibORM tenant Durable Object test worker");
  },
};

export { TenantObject } from "./tenant-object";
