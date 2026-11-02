package com.kumiko.amadeus.app.security;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Internal storage primitive only. Never expose read() on a Capacitor bridge. */
public final class CredentialVault {
    private static final String ALIAS = "kumiko.credentials.v1";
    private final File directory;
    private final SecureRandom random = new SecureRandom();
    public CredentialVault(Context context) {
        directory = new File(context.getNoBackupFilesDir(), "credential-vault");
    }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    private File file(String handle) {
        if (handle == null || !handle.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid credential reference");
        return new File(directory, handle + ".bin");
    }
    private byte[] seal(String plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        return new JSONObject().put("version", 1).put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP)).toString().getBytes(StandardCharsets.UTF_8);
    }
    private String open(byte[] bytes) throws Exception {
        JSONObject sealed = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        if (sealed.getInt("version") != 1) throw new IllegalStateException("Unsupported credential record");
        byte[] iv = Base64.decode(sealed.getString("iv"), Base64.NO_WRAP);
        if (iv.length != 12) throw new IllegalStateException("Invalid credential record");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(Base64.decode(sealed.getString("ciphertext"), Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
    /** Writes a fresh opaque handle only after encrypted readback has succeeded. */
    public synchronized String store(String record) throws Exception {
        if (record == null || record.isEmpty() || record.length() > 16384) throw new IllegalArgumentException("Invalid credential record");
        byte[] bytes = new byte[32]; random.nextBytes(bytes);
        StringBuilder handle = new StringBuilder();
        for (byte b : bytes) handle.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        byte[] encrypted = seal(record);
        if (!record.equals(open(encrypted))) throw new IllegalStateException("Secure storage verification failed");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("Secure storage unavailable");
        AtomicFile atomic = new AtomicFile(file(handle.toString()));
        FileOutputStream output = null;
        try {
            output = atomic.startWrite(); output.write(encrypted); output.getFD().sync(); atomic.finishWrite(output); output = null;
            if (!record.equals(open(atomic.readFully()))) throw new IllegalStateException("Secure storage verification failed");
        } catch (Exception failure) {
            if (output != null) atomic.failWrite(output); else atomic.delete();
            throw new IllegalStateException("Secure storage write or verification failed");
        }
        return handle.toString();
    }
    /** For native proxy use only; never return this value to renderer code. */
    public synchronized String read(String handle) throws Exception {
        AtomicFile atomic = new AtomicFile(file(handle));
        if (!atomic.getBaseFile().exists()) throw new IllegalStateException("Credential unavailable");
        try { return open(atomic.readFully()); }
        catch (Exception failure) { throw new IllegalStateException("Credential unavailable"); }
    }
    public synchronized void delete(String handle) {
        new AtomicFile(file(handle)).delete();
    }
    /** Called only by the confirmed app data reset flow. Retriable after interruption. */
    public synchronized void clear() throws Exception {
        if (directory.exists()) {
            File[] files = directory.listFiles();
            if (files == null) throw new IllegalStateException("Credential storage unavailable");
            for (File entry : files) {
                if (!entry.getName().matches("[0-9a-f]{64}\\.bin(?:\\.bak|\\.new)?")) continue;
                if (!entry.getCanonicalFile().getParentFile().equals(directory.getCanonicalFile()) || !entry.delete())
                    throw new IllegalStateException("Credential cleanup failed");
            }
        }
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS);
    }
}
