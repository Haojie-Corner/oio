const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function getKey() {
  const secret = Deno.env.get("AI_CONFIG_ENCRYPTION_KEY");
  if (!secret || secret.length < 24) {
    throw new Error("AI_CONFIG_ENCRYPTION_KEY 尚未配置或长度不足");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await getKey(),
    encoder.encode(value),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string) {
  const [ivPart, dataPart] = value.split(".");
  if (!ivPart || !dataPart) throw new Error("API Key 密文格式无效");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivPart) },
    await getKey(),
    base64ToBytes(dataPart),
  );
  return decoder.decode(decrypted);
}
