import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { requireAuth } from "./shared/utils.js";
import { wrapZeroized, autoDispose } from "./security-zeroize.js";
import { safeCall } from "./shared/errors.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "vault" },
);

interface VaultEntry {
  key: string;
  iv: string;
  ciphertext: string;
  tag: string;
  createdAt: number;
  updatedAt: number;
}

interface VaultState {
  unlocked: boolean;
  cryptoKey: CryptoKey | null;
  salt: string | null;
  autoLockTimer: ReturnType<typeof setTimeout> | null;
  autoLockMs: number;
}

const vault: VaultState = {
  unlocked: false,
  cryptoKey: null,
  salt: null,
  autoLockTimer: null,
  autoLockMs: 30 * 60 * 1000,
};

function assertUnlocked() {
  if (!vault.unlocked || !vault.cryptoKey) {
    throw new Error("Vault is locked. Call vault::init first.");
  }
}

function resetAutoLock() {
  if (vault.autoLockTimer) clearTimeout(vault.autoLockTimer);
  vault.autoLockTimer = setTimeout(() => {
    vault.unlocked = false;
    vault.cryptoKey = null;
    triggerVoid("security::audit", {
      type: "vault_auto_locked",
      detail: { after: vault.autoLockMs },
    });
  }, vault.autoLockMs);
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations: 600_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(
  key: CryptoKey,
  plaintext: string,
): Promise<{ iv: string; ciphertext: string; tag: string }> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    encoder.encode(plaintext),
  );

  const buf = new Uint8Array(encrypted);
  const ciphertext = buf.slice(0, buf.length - 16);
  const tag = buf.slice(buf.length - 16);

  return {
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    tag: Buffer.from(tag).toString("base64"),
  };
}

async function decrypt(
  key: CryptoKey,
  entry: { iv: string; ciphertext: string; tag: string },
): Promise<string> {
  const iv = Buffer.from(entry.iv, "base64");
  const ciphertext = Buffer.from(entry.ciphertext, "base64");
  const tag = Buffer.from(entry.tag, "base64");

  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    combined,
  );

  return new TextDecoder().decode(decrypted);
}

registerFunction(
  {
    id: "vault::init",
    description: "Initialize vault with master password",
    metadata: { category: "vault" },
  },
  async (req: any) => {
    requireAuth(req);
    const { password, autoLockMinutes } = req.body || req;
    if (!password || password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }

    if (autoLockMinutes !== undefined) {
      vault.autoLockMs = autoLockMinutes * 60 * 1000;
    }

    const existing: any = await safeCall(
      () => trigger("state::get", { scope: "vault", key: "__meta" }),
      null,
      { operation: "vault_init_meta", functionId: "vault::init" },
    );

    let salt: Uint8Array;

    if (existing?.salt) {
      salt = Buffer.from(existing.salt, "base64");
    } else {
      salt = crypto.getRandomValues(new Uint8Array(32));
      await trigger("state::set", {
        scope: "vault",
        key: "__meta",
        value: {
          salt: Buffer.from(salt).toString("base64"),
          createdAt: Date.now(),
        },
      });
    }

    vault.cryptoKey = await deriveKey(password, salt);
    vault.salt = Buffer.from(salt).toString("base64");
    vault.unlocked = true;

    resetAutoLock();

    triggerVoid("security::audit", {
      type: "vault_unlocked",
      detail: { autoLockMs: vault.autoLockMs },
    });

    return { unlocked: true, autoLockMinutes: vault.autoLockMs / 60_000 };
  },
);

registerFunction(
  {
    id: "vault::set",
    description: "Store an encrypted credential",
    metadata: { category: "vault" },
  },
  async (req: any) => {
    requireAuth(req);
    const { key, value } = req.body || req;
    assertUnlocked();
    resetAutoLock();

    if (!key || key.startsWith("__")) throw new Error("Invalid key");

    const encrypted = await encrypt(vault.cryptoKey!, value);

    const entry: VaultEntry = {
      key,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      tag: encrypted.tag,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const existing: any = await safeCall(
      () => trigger("state::get", { scope: "vault", key }),
      null,
      { operation: "vault_set_lookup", functionId: "vault::set" },
    );

    if (existing) {
      entry.createdAt = existing.createdAt;
    }

    await trigger("state::set", { scope: "vault", key, value: entry });

    triggerVoid("security::audit", {
      type: "vault_set",
      detail: { key },
    });

    return { stored: true, key, updatedAt: entry.updatedAt };
  },
);

registerFunction(
  {
    id: "vault::get",
    description: "Retrieve and decrypt a credential",
    metadata: { category: "vault" },
  },
  async (req: any) => {
    requireAuth(req);
    const { key } = req.body || req;
    assertUnlocked();
    resetAutoLock();

    const entry = await safeCall(
      () =>
        trigger("state::get", {
          scope: "vault",
          key,
        }) as Promise<VaultEntry | null>,
      null,
      { operation: "vault_get_lookup", functionId: "vault::get" },
    );

    if (!entry || !entry.ciphertext)
      throw new Error(`Credential not found: ${key}`);

    const plaintext = await decrypt(vault.cryptoKey!, {
      iv: entry.iv,
      ciphertext: entry.ciphertext,
      tag: entry.tag,
    });

    const zb = wrapZeroized(plaintext);
    autoDispose(zb, 30_000);

    triggerVoid("security::audit", {
      type: "vault_get",
      detail: { key },
    });

    return {
      key,
      value: zb.toString(),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  },
);

registerFunction(
  {
    id: "vault::list",
    description: "List stored credential keys without values",
    metadata: { category: "vault" },
  },
  async (req: any) => {
    requireAuth(req);
    assertUnlocked();
    resetAutoLock();

    const entries: any = await trigger("state::list", { scope: "vault" }).catch(
      () => [],
    );

    const keys = entries
      .filter((e: any) => e.key !== "__meta" && e.value?.ciphertext)
      .map((e: any) => ({
        key: e.key,
        createdAt: e.value.createdAt,
        updatedAt: e.value.updatedAt,
      }));

    return { keys, count: keys.length };
  },
);

registerFunction(
  {
    id: "vault::delete",
    description: "Remove a credential",
    metadata: { category: "vault" },
  },
  async (req: any) => {
    requireAuth(req);
    const { key } = req.body || req;
    assertUnlocked();
    resetAutoLock();

    if (key === "__meta") throw new Error("Cannot delete vault metadata");

    await trigger("state::delete", { scope: "vault", key });

    triggerVoid("security::audit", {
      type: "vault_delete",
      detail: { key },
    });

    return { deleted: true, key };
  },
);

registerFunction(
  {
    id: "vault::rotate",
    description: "Re-encrypt all credentials with a new master password",
    metadata: { category: "vault" },
  },
  async (req: any) => {
    requireAuth(req);
    const { currentPassword, newPassword } = req.body || req;
    assertUnlocked();

    if (!newPassword || newPassword.length < 8) {
      throw new Error("New password must be at least 8 characters");
    }

    const meta: any = await trigger("state::get", {
      scope: "vault",
      key: "__meta",
    });
    const oldSalt = Buffer.from(meta.salt, "base64");
    const oldKey = await deriveKey(currentPassword, oldSalt);

    const entries: any = await trigger("state::list", { scope: "vault" }).catch(
      () => [],
    );
    const credentials = entries.filter(
      (e: any) => e.key !== "__meta" && e.value?.ciphertext,
    );

    await trigger("state::set", {
      scope: "vault_backup",
      key: "__meta",
      value: meta,
    });
    for (const entry of credentials) {
      await trigger("state::set", {
        scope: "vault_backup",
        key: entry.key,
        value: entry.value,
      });
    }

    const newSalt = crypto.getRandomValues(new Uint8Array(32));
    const newKey = await deriveKey(newPassword, newSalt);

    const updates: Array<{ key: string; value: any }> = [];
    for (const entry of credentials) {
      const plaintext = await decrypt(oldKey, {
        iv: entry.value.iv,
        ciphertext: entry.value.ciphertext,
        tag: entry.value.tag,
      });
      const encrypted = await encrypt(newKey, plaintext);
      updates.push({
        key: entry.key,
        value: {
          ...entry.value,
          iv: encrypted.iv,
          ciphertext: encrypted.ciphertext,
          tag: encrypted.tag,
          updatedAt: Date.now(),
        },
      });
    }

    try {
      for (const { key, value } of updates) {
        await trigger("state::set", { scope: "vault", key, value });
      }

      await trigger("state::set", {
        scope: "vault",
        key: "__meta",
        value: {
          salt: Buffer.from(newSalt).toString("base64"),
          createdAt: meta.createdAt,
          rotatedAt: Date.now(),
        },
      });
    } catch (err) {
      for (const entry of credentials) {
        const backup: any = await safeCall(
          () =>
            trigger("state::get", { scope: "vault_backup", key: entry.key }),
          null,
          { operation: "vault_rotate_rollback", functionId: "vault::rotate" },
        );
        if (backup) {
          await trigger("state::set", {
            scope: "vault",
            key: entry.key,
            value: backup,
          });
        }
      }
      const backupMeta: any = await safeCall(
        () => trigger("state::get", { scope: "vault_backup", key: "__meta" }),
        null,
        {
          operation: "vault_rotate_rollback_meta",
          functionId: "vault::rotate",
        },
      );
      if (backupMeta) {
        await trigger("state::set", {
          scope: "vault",
          key: "__meta",
          value: backupMeta,
        });
      }

      triggerVoid("security::audit", {
        type: "vault_rotation_failed",
        detail: { error: (err as Error).message, rolledBack: true },
      });
      throw new Error(
        `Vault rotation failed, rolled back: ${(err as Error).message}`,
      );
    }

    vault.cryptoKey = newKey;
    vault.salt = Buffer.from(newSalt).toString("base64");
    resetAutoLock();

    triggerVoid("security::audit", {
      type: "vault_rotated",
      detail: { credentialsRotated: updates.length },
    });

    return { rotated: updates.length, success: true };
  },
);

registerFunction(
  {
    id: "vault::backup",
    description: "Backup current vault state",
    metadata: { category: "vault" },
  },
  async (req: any) => {
    requireAuth(req);
    assertUnlocked();
    resetAutoLock();

    const meta: any = await trigger("state::get", {
      scope: "vault",
      key: "__meta",
    });
    const entries: any = await trigger("state::list", { scope: "vault" }).catch(
      () => [],
    );
    const credentials = entries.filter(
      (e: any) => e.key !== "__meta" && e.value?.ciphertext,
    );

    await trigger("state::set", {
      scope: "vault_backup",
      key: "__meta",
      value: meta,
    });
    for (const entry of credentials) {
      await trigger("state::set", {
        scope: "vault_backup",
        key: entry.key,
        value: entry.value,
      });
    }

    triggerVoid("security::audit", {
      type: "vault_backup_created",
      detail: { credentialsCount: credentials.length },
    });

    return { backedUp: credentials.length, success: true };
  },
);

registerFunction(
  {
    id: "vault::restore",
    description: "Restore vault from backup",
    metadata: { category: "vault" },
  },
  async (req: any) => {
    requireAuth(req);
    const { password } = req.body || req;

    const backupMeta: any = await safeCall(
      () => trigger("state::get", { scope: "vault_backup", key: "__meta" }),
      null,
      { operation: "vault_restore_meta", functionId: "vault::restore" },
    );
    if (!backupMeta) throw new Error("No vault backup found");

    const backupEntries: any = await safeCall(
      () => trigger("state::list", { scope: "vault_backup" }),
      [],
      { operation: "vault_restore_list", functionId: "vault::restore" },
    );
    const credentials = backupEntries.filter(
      (e: any) => e.key !== "__meta" && e.value?.ciphertext,
    );

    await trigger("state::set", {
      scope: "vault",
      key: "__meta",
      value: backupMeta,
    });
    for (const entry of credentials) {
      await trigger("state::set", {
        scope: "vault",
        key: entry.key,
        value: entry.value,
      });
    }

    if (password) {
      if (password.length < 8) {
        throw new Error("Password must be at least 8 characters");
      }
      const salt = Buffer.from(backupMeta.salt, "base64");
      vault.cryptoKey = await deriveKey(password, salt);
      vault.salt = backupMeta.salt;
      vault.unlocked = true;
      resetAutoLock();
    }

    triggerVoid("security::audit", {
      type: "vault_restored",
      detail: { credentialsCount: credentials.length },
    });

    return { restored: credentials.length, success: true };
  },
);

registerTrigger({
  type: "http",
  function_id: "vault::init",
  config: { api_path: "api/vault/init", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "vault::set",
  config: { api_path: "api/vault/set", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "vault::get",
  config: { api_path: "api/vault/get", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "vault::list",
  config: { api_path: "api/vault/list", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "vault::delete",
  config: { api_path: "api/vault/delete", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "vault::rotate",
  config: { api_path: "api/vault/rotate", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "vault::backup",
  config: { api_path: "api/vault/backup", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "vault::restore",
  config: { api_path: "api/vault/restore", http_method: "POST" },
});
