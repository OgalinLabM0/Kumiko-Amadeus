package com.kumiko.amadeus.app.security;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Credentials never leave this plugin after storage. All destinations are bound at store time. */
@CapacitorPlugin(name = "KumikoCredentials")
public final class KumikoCredentialsPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final java.util.concurrent.ScheduledExecutorService timeouts = Executors.newSingleThreadScheduledExecutor();
    private final java.util.concurrent.atomic.AtomicLong generation = new java.util.concurrent.atomic.AtomicLong();
    private final java.util.concurrent.ConcurrentHashMap<String, HttpURLConnection> active = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Set<String> cancelled = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private CredentialVault vault() { return new CredentialVault(getContext()); }
    private void assertGeneration(PluginCall call) {
        Long expected = call.getLong("generation");
        if (expected == null || expected.longValue() != generation.get()) throw new IllegalStateException("Data changed");
    }
    private URL endpoint(String raw) throws Exception {
        URL url = new URL(raw);
        if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null)
            throw new IllegalArgumentException("Invalid secure endpoint");
        return url;
    }
    private JSONObject load(String handle, String purpose, String expected) throws Exception {
        JSONObject item = new JSONObject(vault().read(handle));
        if (!purpose.equals(item.getString("purpose")) || !endpoint(item.getString("endpoint")).toString().equals(endpoint(expected).toString()))
            throw new IllegalStateException("Credential binding does not match");
        return item;
    }
    @PluginMethod public void store(PluginCall call) {
        worker.execute(() -> { try {
            Long expected=call.getLong("generation");
            if (expected == null || expected.longValue() != generation.get()) throw new IllegalStateException();
            String purpose = call.getString("purpose"), target = call.getString("endpoint"), secret = call.getString("secret");
            if (purpose == null || !purpose.matches("gemini|openai|anthropic|embedding|embedding-gemini|fish|vocu|tavily") || secret == null || secret.trim().isEmpty()
                || secret.length() > 8192 || secret.contains("\n") || secret.contains("\r")) throw new IllegalArgumentException();
            String safeTarget = endpoint(target).toString();
            String handle = vault().store(new JSONObject().put("version",1).put("purpose",purpose).put("endpoint",safeTarget).put("secret",secret).toString());
            if (expected.longValue() != generation.get()) { vault().delete(handle); throw new IllegalStateException(); }
            JSObject result = new JSObject(); result.put("success",true); result.put("handle",handle); call.resolve(result);
        } catch (Exception error) { call.reject("Secure credential storage failed."); } });
    }
    @PluginMethod public void version(PluginCall call) { JSObject result=new JSObject(); result.put("generation",generation.get()); call.resolve(result); }
    private byte[] send(String requestId, String destination, String method, String secret, String header, String body, String model, boolean anthropic) throws Exception {
        if (requestId == null || !requestId.matches("[a-fA-F0-9-]{36}") || cancelled.remove(requestId)) throw new IllegalStateException("Request cancelled");
        URL destinationUrl = new URL(destination);
        if (destinationUrl.getQuery() == null) endpoint(destination);
        else if (!"GET".equals(method) || !"https".equals(destinationUrl.getProtocol()) || !"search.omkk.org".equals(destinationUrl.getHost())
            || !"/api/search".equals(destinationUrl.getPath()) || !destinationUrl.getQuery().startsWith("q=") || destinationUrl.getQuery().contains("&")) throw new IllegalArgumentException();
        HttpURLConnection connection = (HttpURLConnection) destinationUrl.openConnection();
        active.put(requestId,connection);
        if (cancelled.remove(requestId)) { active.remove(requestId); connection.disconnect(); throw new IllegalStateException("Request cancelled"); }
        java.util.concurrent.ScheduledFuture<?> deadline = timeouts.schedule(connection::disconnect, 120, java.util.concurrent.TimeUnit.SECONDS);
        try {
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(30000); connection.setReadTimeout(120000);
        connection.setRequestMethod(method); connection.setRequestProperty(header, header.equals("Authorization") ? "Bearer " + secret : secret);
        if (anthropic) connection.setRequestProperty("anthropic-version", "2023-06-01");
        if (model != null) connection.setRequestProperty("model", model);
        if (body != null) { connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
            try (java.io.OutputStream out = connection.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); } }
        int status = connection.getResponseCode();
        if (status >= 300 && status < 400) throw new IllegalStateException("Redirect rejected");
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        if (stream != null) try (InputStream input = stream) { byte[] chunk = new byte[8192]; int n; while ((n = input.read(chunk)) != -1) {
            if (output.size() + n > 16 * 1024 * 1024) throw new IllegalStateException("Response too large"); output.write(chunk,0,n);
        }}
        byte[] bytes = output.toByteArray();
        if (new String(bytes, StandardCharsets.ISO_8859_1).contains(secret)) throw new IllegalStateException("Invalid response");
        JSONObject envelope = new JSONObject().put("status",status).put("body",Base64.encodeToString(bytes,Base64.NO_WRAP))
            .put("contentType",connection.getContentType() == null ? "" : connection.getContentType());
        return envelope.toString().getBytes(StandardCharsets.UTF_8);
        } finally { deadline.cancel(false); active.remove(requestId); cancelled.remove(requestId); connection.disconnect(); }
    }
    @PluginMethod public void request(PluginCall call) {
        worker.execute(() -> { try {
            assertGeneration(call);
            String purpose=call.getString("purpose"), target=call.getString("expectedEndpoint"), handle=call.getString("handle"), body=call.getString("body");
            if (purpose == null || !purpose.matches("openai|anthropic|embedding|embedding-gemini|fish|vocu") || body == null || body.length()>8*1024*1024) throw new IllegalArgumentException();
            String model=call.getString("model"); JSONObject item;
            if (purpose.equals("embedding-gemini")) {
                item = new JSONObject(vault().read(handle));
                String bound = endpoint(item.getString("endpoint")).toString();
                String base = "https://generativelanguage.googleapis.com/";
                boolean legacy = bound.matches("https://generativelanguage\\.googleapis\\.com/v1beta/models/[A-Za-z0-9._-]{1,200}:embedContent") && !bound.contains("..");
                if (!purpose.equals(item.getString("purpose")) || !base.equals(target) || (!base.equals(bound) && !legacy)
                    || model == null || !model.matches("[A-Za-z0-9._-]{1,200}") || model.contains("..")) throw new IllegalArgumentException();
                target = base + "v1beta/models/" + model + ":embedContent";
                model = null;
            } else item=load(handle,purpose,target);
            if (purpose.equals("fish") && !("s1".equals(model) || "s2-pro".equals(model))) throw new IllegalArgumentException();
            if (!purpose.equals("fish") && model != null) throw new IllegalArgumentException();
            String header=purpose.equals("anthropic") ? "x-api-key" : purpose.equals("embedding-gemini") ? "x-goog-api-key" : "Authorization";
            JSONObject data=new JSONObject(new String(send(call.getString("requestId"),target,"POST",item.getString("secret"),header,body,model,purpose.equals("anthropic")),StandardCharsets.UTF_8));
            JSObject result=new JSObject(); result.put("success",true); result.put("result",data); call.resolve(result);
        } catch (Exception error) { call.reject("Protected API request failed."); } });
    }
    @PluginMethod public void gemini(PluginCall call) {
        worker.execute(() -> { try {
            assertGeneration(call);
            String target=call.getString("expectedEndpoint"), handle=call.getString("handle"); JSONObject params=call.getObject("params");
            JSONObject item=load(handle,"gemini",target); String model=params.getString("model");
            if (!model.matches("[A-Za-z0-9._:/-]{1,200}") || model.contains("..") || model.contains("//")) throw new IllegalArgumentException();
            JSONObject config=params.optJSONObject("config"); if (config == null) config=new JSONObject();
            if (config.has("httpOptions")) throw new IllegalArgumentException();
            JSONObject body=new JSONObject(); Object contents=params.get("contents");
            if (contents instanceof String) body.put("contents",new JSONArray().put(new JSONObject().put("role","user").put("parts",new JSONArray().put(new JSONObject().put("text",contents)))));
            else if (contents instanceof JSONArray && ((JSONArray)contents).length()>0 && ((JSONArray)contents).optJSONObject(0)!=null && !((JSONArray)contents).optJSONObject(0).has("role")) body.put("contents",new JSONArray().put(new JSONObject().put("role","user").put("parts",contents)));
            else body.put("contents",contents);
            for (String field : new String[]{"tools","toolConfig","safetySettings","cachedContent"}) if (config.has(field)) body.put(field,config.get(field));
            Object instruction=config.opt("systemInstruction");
            if (instruction instanceof String) body.put("systemInstruction",new JSONObject().put("parts",new JSONArray().put(new JSONObject().put("text",instruction))));
            else if (instruction != null && instruction != JSONObject.NULL) body.put("systemInstruction",instruction);
            JSONObject generation=new JSONObject();
            for (String field : new String[]{"temperature","topP","topK","maxOutputTokens","responseMimeType","responseSchema","candidateCount","stopSequences","seed","thinkingConfig"}) if(config.has(field)) generation.put(field,config.get(field));
            if (generation.length()>0) body.put("generationConfig",generation);
            String base=target.endsWith("/") ? target : target + "/";
            String destination=base + "v1beta/models/" + model.replaceFirst("^models/","") + ":generateContent";
            JSONObject envelope=new JSONObject(new String(send(call.getString("requestId"),destination,"POST",item.getString("secret"),"x-goog-api-key",body.toString(),null,false),StandardCharsets.UTF_8));
            int status=envelope.getInt("status"); if(status<200 || status>=300) throw new IllegalStateException("HTTP " + status);
            JSONObject result=new JSONObject(new String(Base64.decode(envelope.getString("body"),Base64.NO_WRAP),StandardCharsets.UTF_8));
            JSONArray candidates=result.optJSONArray("candidates"), calls=new JSONArray(); StringBuilder text=new StringBuilder();
            JSONObject first=candidates==null ? null : candidates.optJSONObject(0); JSONObject content=first==null ? null : first.optJSONObject("content"); JSONArray parts=content==null ? null : content.optJSONArray("parts");
            if(parts!=null) for(int i=0;i<parts.length();i++){JSONObject part=parts.optJSONObject(i);if(part==null)continue;if(part.has("text"))text.append(part.optString("text"));if(part.has("functionCall"))calls.put(part.get("functionCall"));}
            result.put("text",text.toString()); if(calls.length()>0)result.put("functionCalls",calls);
            JSObject output=new JSObject(); output.put("success",true); output.put("result",result); call.resolve(output);
        } catch (Exception error) { call.reject("Protected Gemini request failed."); } });
    }
    @PluginMethod public void tavily(PluginCall call) {
        worker.execute(() -> { try {
            assertGeneration(call);
            String operation=call.getString("operation"), handle=call.getString("handle"), query=call.getString("query", "");
            JSONObject item=load(handle,"tavily","https://search.omkk.org/");
            if (!("search".equals(operation) || "usage".equals(operation)) || ("search".equals(operation) && (query.trim().isEmpty() || query.length()>4000))) throw new IllegalArgumentException();
            String target="https://search.omkk.org/api/" + operation;
            if ("search".equals(operation)) target += "?q=" + java.net.URLEncoder.encode(query,"UTF-8");
            JSONObject envelope=new JSONObject(new String(send(call.getString("requestId"),target,"GET",item.getString("secret"),"x-api-key",null,null,false),StandardCharsets.UTF_8));
            JSObject response=new JSObject(); response.put("status",envelope.getInt("status")); response.put("body",new String(Base64.decode(envelope.getString("body"),Base64.NO_WRAP),StandardCharsets.UTF_8));
            JSObject result=new JSObject(); result.put("success",true); result.put("result",response); call.resolve(result);
        } catch(Exception error) { call.reject("Protected search request failed."); } });
    }
    @PluginMethod public void clear(PluginCall call) {
        generation.incrementAndGet();
        for (HttpURLConnection connection : active.values()) connection.disconnect();
        worker.execute(() -> { try { vault().clear(); JSObject result=new JSObject(); result.put("success",true); call.resolve(result); }
        catch(Exception error) { call.reject("Credential cleanup failed."); } });
    }
    @PluginMethod public void cancel(PluginCall call) {
        String id=call.getString("requestId");
        if (id == null || !id.matches("[a-fA-F0-9-]{36}")) { call.reject("Invalid request identity."); return; }
        if (cancelled.size() < 1024) { cancelled.add(id); timeouts.schedule(() -> cancelled.remove(id), 120, java.util.concurrent.TimeUnit.SECONDS); }
        HttpURLConnection connection=active.get(id); if (connection != null) connection.disconnect();
        JSObject result=new JSObject(); result.put("success",true); call.resolve(result);
    }
    @Override protected void handleOnDestroy() { for (HttpURLConnection connection : active.values()) connection.disconnect(); worker.shutdownNow(); timeouts.shutdownNow(); super.handleOnDestroy(); }
}
