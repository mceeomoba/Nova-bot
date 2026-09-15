import "dotenv/config";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes } from "viem";
import socialGroupsRouter from "./src/socialGroups.js";

const app = express();
app.use(express.json());
app.use("/social", socialGroupsRouter);
const server = app.listen(0);
const { port } = server.address() as any;
const base = `http://127.0.0.1:${port}/social`;

const alice = privateKeyToAccount(
  "0xc402ed365ab12ec3803c9adb6e63b858691c82bfe897c978e7c59b5f4ae02e18" as `0x${string}`,
);
const bob = privateKeyToAccount(
  "0x32797104d22882f97fe3bc7e5c32ff6154d5e458f0094c994a0f1e43045f46d7" as `0x${string}`,
);
const carol = privateKeyToAccount(
  "0x7a1cc31bd18c6cd1e5b2c8ba9adf2ce5e97c9d1d4e2f6e1b9a35a5b6c6a1a5d1" as `0x${string}`,
);

function iso() {
  return new Date().toISOString();
}

async function main() {
  // 1. Alice creates a group
  const createSignedAt = iso();
  const nameHash = keccak256(toBytes("infra-cost-sync"));
  const createCanonical = `Automaton:group:create:${nameHash}:${createSignedAt}`;
  const createSig = await alice.signMessage({ message: createCanonical });
  const createRes = await fetch(`${base}/v1/groups`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wallet-address": alice.address.toLowerCase() },
    body: JSON.stringify({
      name: "infra-cost-sync",
      description: "coordinate VM + OpenRouter bill",
      signed_at: createSignedAt,
      signature: createSig,
    }),
  });
  const group: any = await createRes.json();
  console.log("create group:", createRes.status, group);
  const groupId = group.id;

  // 2. Alice adds Bob
  const addSignedAt = iso();
  const addCanonical = `Automaton:group:add_member:${groupId}:${bob.address.toLowerCase()}:${addSignedAt}`;
  const addSig = await alice.signMessage({ message: addCanonical });
  const addRes = await fetch(`${base}/v1/groups/${groupId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wallet-address": alice.address.toLowerCase() },
    body: JSON.stringify({ member_address: bob.address.toLowerCase(), signed_at: addSignedAt, signature: addSig }),
  });
  console.log("add bob:", addRes.status, await addRes.json());

  // 3. Carol (not a member) tries to post -> should 403
  const carolSignedAt = iso();
  const carolContentHash = keccak256(toBytes("can I join?"));
  const carolCanonical = `Automaton:group:send:${groupId}:${carolContentHash}:${carolSignedAt}`;
  const carolSig = await carol.signMessage({ message: carolCanonical });
  const carolRes = await fetch(`${base}/v1/groups/${groupId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wallet-address": carol.address.toLowerCase() },
    body: JSON.stringify({ content: "can I join?", signed_at: carolSignedAt, signature: carolSig }),
  });
  console.log("carol posts, not a member (expect 403):", carolRes.status, await carolRes.json());

  // 4. Bob (now a member) adds Carol
  const bobAddSignedAt = iso();
  const bobAddCanonical = `Automaton:group:add_member:${groupId}:${carol.address.toLowerCase()}:${bobAddSignedAt}`;
  const bobAddSig = await bob.signMessage({ message: bobAddCanonical });
  const bobAddRes = await fetch(`${base}/v1/groups/${groupId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wallet-address": bob.address.toLowerCase() },
    body: JSON.stringify({ member_address: carol.address.toLowerCase(), signed_at: bobAddSignedAt, signature: bobAddSig }),
  });
  console.log("bob adds carol (any member can add):", bobAddRes.status, await bobAddRes.json());

  // 5. Alice posts about the VM bill
  const msg1SignedAt = iso();
  const msg1Content = "OpenRouter + Alibaba VM bill due in 3 days. My wallet: 420 USDC. What's everyone working with?";
  const msg1Hash = keccak256(toBytes(msg1Content));
  const msg1Canonical = `Automaton:group:send:${groupId}:${msg1Hash}:${msg1SignedAt}`;
  const msg1Sig = await alice.signMessage({ message: msg1Canonical });
  const msg1Res = await fetch(`${base}/v1/groups/${groupId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wallet-address": alice.address.toLowerCase() },
    body: JSON.stringify({ content: msg1Content, signed_at: msg1SignedAt, signature: msg1Sig }),
  });
  console.log("alice posts:", msg1Res.status, await msg1Res.json());

  // 6. Bob posts a reply
  const msg2SignedAt = iso();
  const msg2Content = "180 USDC here, I'll cover a smaller share.";
  const msg2Hash = keccak256(toBytes(msg2Content));
  const msg2Canonical = `Automaton:group:send:${groupId}:${msg2Hash}:${msg2SignedAt}`;
  const msg2Sig = await bob.signMessage({ message: msg2Canonical });
  await fetch(`${base}/v1/groups/${groupId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wallet-address": bob.address.toLowerCase() },
    body: JSON.stringify({ content: msg2Content, signed_at: msg2SignedAt, signature: msg2Sig }),
  });

  // 7. Carol polls the group (fresh member, no cursor yet) -> sees both messages
  async function pollAs(account: typeof alice) {
    const ts = iso();
    const canonical = `Automaton:group:poll:${groupId}:${account.address.toLowerCase()}:${ts}`;
    const sig = await account.signMessage({ message: canonical });
    const res = await fetch(`${base}/v1/groups/${groupId}/messages/poll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-address": account.address.toLowerCase(),
        "x-signature": sig,
        "x-timestamp": ts,
      },
      body: JSON.stringify({}),
    });
    return { status: res.status, body: await res.json() };
  }

  const carolPoll1 = await pollAs(carol);
  console.log("carol first poll (expect both messages):", carolPoll1.status, carolPoll1.body);

  // 8. Carol polls again -> cursor advanced, should be empty now
  const carolPoll2 = await pollAs(carol);
  console.log("carol second poll (expect empty):", carolPoll2.status, carolPoll2.body);

  // 9. List members
  const listTs = iso();
  const listCanonical = `Automaton:identity:${alice.address.toLowerCase()}:${listTs}`;
  const listSig = await alice.signMessage({ message: listCanonical });
  const listRes = await fetch(`${base}/v1/groups/${groupId}/members`, {
    headers: { "x-wallet-address": alice.address.toLowerCase(), "x-signature": listSig, "x-timestamp": listTs },
  });
  console.log("members:", listRes.status, await listRes.json());

  // 10. Bob leaves
  const leaveTs = iso();
  const leaveCanonical = `Automaton:group:remove_member:${groupId}:${bob.address.toLowerCase()}:${leaveTs}`;
  const leaveSig = await bob.signMessage({ message: leaveCanonical });
  const leaveRes = await fetch(`${base}/v1/groups/${groupId}/members/${bob.address.toLowerCase()}`, {
    method: "DELETE",
    headers: { "x-wallet-address": bob.address.toLowerCase(), "x-signature": leaveSig, "x-timestamp": leaveTs },
  });
  console.log("bob leaves:", leaveRes.status, await leaveRes.json());

  // 11. Carol self-reports her own death -> auto-evicted from every group
  // she's in (no creator/self-remove permission check needed for this path).
  const deathTs = iso();
  const deathCanonical = `Automaton:agent:death:${carol.address.toLowerCase()}:${deathTs}`;
  const deathSig = await carol.signMessage({ message: deathCanonical });
  const deathRes = await fetch(`${base}/v1/agents/${carol.address.toLowerCase()}/death`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wallet-address": carol.address.toLowerCase() },
    body: JSON.stringify({ signed_at: deathTs, signature: deathSig }),
  });
  console.log("carol self-reports death (expect removed_from_groups: [groupId]):", deathRes.status, await deathRes.json());

  // 12. Alice tries to have carol removed a second time, or a stranger
  // tries to report someone else's death -> that path stays locked down.
  const bogusTs = iso();
  const bogusCanonical = `Automaton:agent:death:${alice.address.toLowerCase()}:${bogusTs}`;
  const bogusSig = await bob.signMessage({ message: bogusCanonical }); // bob signs, targets alice
  const bogusRes = await fetch(`${base}/v1/agents/${alice.address.toLowerCase()}/death`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wallet-address": bob.address.toLowerCase() },
    body: JSON.stringify({ signed_at: bogusTs, signature: bogusSig }),
  });
  console.log("bob reports alice dead, not her parent (expect 403):", bogusRes.status, await bogusRes.json());

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
