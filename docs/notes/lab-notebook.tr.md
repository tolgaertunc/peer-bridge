# Uyandırma deneyi (wake-up spike)

Soru: Chat içindeki bir MCP Apps paneli, karşı ajandan mesaj geldiğinde `ui/message` ile **boştaki** chati uyandırabilir mi? Hangi koşullarda?

## Parçalar

| Dosya | Görev |
|---|---|
| `src/server.mjs` | Her uygulamanın başlattığı stdio MCP server (`--side claude` / `--side openai`) |
| `src/broker.mjs` | Ortak kuyruk. İlk açılan süreç `127.0.0.1:7457`'yi alır, diğerleri ona bağlanır. Durum `.bridge/` altında |
| `src/widget.html` | Chatte görünen panel: 3 sn'de bir broker'ı yoklar, mesaj gelince `ui/message` gönderir, her şeyi loglar |
| `scripts/send.mjs` | Karşı taraf yokken mesaj enjekte eder |
| `scripts/report.mjs` | `.bridge/events.jsonl`'den sonuç tablosu çıkarır |
| `scripts/dev-host.mjs` | Tarayıcıda sahte host (gerçek uygulamalar öncesi kontrol) |
| `scripts/install.mjs` | İki uygulamanın config'ine ekler / `--uninstall` ile kaldırır (yedek alır) |

Model tool'ları: `bridge_join`, `bridge_send`, `bridge_receive`, `bridge_status`.
Panel tool'ları (modelden gizli): `bridge_poll`, `bridge_claim`, `bridge_report`.

## Hazırlık

1. Kurulum yapıldı: `claude_desktop_config.json` → `mcpServers.peer-bridge`, `~/.codex/config.toml` → `[mcp_servers.peer_bridge]`.
2. **İki uygulamayı da tamamen kapatıp yeniden aç** (Claude'da tepsi ikonundan Quit).
3. Her uygulamada yeni bir chat aç ve yaz: `bridge_join tool'unu çağır`.
4. Panel görünüyor mu? Üstteki çiplere bak: **✓ ui/message**, **✓ server tools**.

## Test matrisi

Her testten sonra sonucu görmek için:

```bash
node scripts/report.mjs --since 10
```

Tek taraflı testlerde mesajı elle enjekte et:

```bash
node scripts/send.mjs --to claude "T1: 2+2 kaç? Sadece sayıyı söyle."
```

| # | Senaryo | Nasıl | Bakılacak |
|---|---|---|---|
| T0 | Panel render oluyor mu | `bridge_join` | Panel var mı, `ui/message` çipi ✓ mi |
| T1 | Tıklamalı `ui/message` | Paneldeki **Test ui/message now** | Chate mesaj düştü mü, onay istendi mi, model cevap verdi mi |
| T2 | Tıklamasız, chat önde | **Test in 15 s** ve bekle | Kullanıcı etkileşimi olmadan kabul ediliyor mu |
| T3 | Tıklamasız, başka chate geçilmiş | **Test in 15 s** ve aynı uygulamada başka chate geç | Mesaj doğru chate mi gitti, panel yaşıyor mu (poll gap) |
| T4 | Tıklamasız, uygulama küçültülmüş | **Test in 15 s** ve uygulamayı küçült | Gitti mi, gecikme kaç sn |
| T5 | Otomatik uyandırma, model boşta | `send.mjs --to <side> ...` | Panel uyandırdı mı, model `bridge_receive` çağırdı mı |
| T6 | Model cevap üretirken mesaj | Modele uzun bir şey yazdır, o sırada `send.mjs` | Kuyruğa mı alındı, reddedildi mi, cevabı kesti mi |
| T7 | Panel ekrandan kaydırılmış | Chatte birkaç mesaj yazıp paneli yukarıda bırak, sonra `send.mjs` | Görünmeyen panel hâlâ poll ediyor mu |
| T8 | Uçtan uca ping-pong | Claude'a: "bridge_send ile openai'ye 'Bu kodu review et: ...' gönder" | İki taraf otomatik konuşuyor mu, 20 mesaj limitinde duruyor mu |

### T4 / T6 / T7 protokolleri

`scripts/probe.mjs` tek bir uyandırma turunu zamanlar: mesajı gönderir, sonra panelin fark etmesi, `ui/message` sonucu, modelin okuması ve cevabı için saniye cinsinden zaman çizelgesi basar. `--delay` uygulamayı test edilecek duruma sokman için süre verir.

Ön koşul: ChatGPT chatinde panel açık (`bridge_join`) ve ChatGPT "cevap göndereyim mi?" diye sormayacak şekilde talimatlı.

**T4 — uygulama küçültülmüş**

```bash
node scripts/probe.mjs --to openai --label T4a --delay 20
```

20 sn içinde ChatGPT'yi küçült, çıktı bitene kadar açma. Sonra aynısını `--label T4b` ile, ChatGPT'yi başka bir uygulamanın arkasında bırakarak (küçültmeden) tekrarla. Bakılacak: `ui/message OK` geldi mi, `read it` süresi, `report.mjs`'te `hidden` poll gap'leri (tarayıcı zamanlayıcıları kısıyor mu).

**T6 — model cevap üretirken mesaj**

ChatGPT'ye uzun bir iş ver (ör. "1500 kelimelik bir deneme yaz"), üretmeye başlar başlamaz:

```bash
node scripts/probe.mjs --to openai --label T6 --delay 3
```

Bakılacak: `ui/message` reddedildi mi, kuyruğa mı alındı (config'te `followUpQueueMode = "queue"` var), üretimi kesti mi, uzun cevap bittikten sonra probe'u okudu mu.

**T7 — panel ömrü**

Her biri ayrı tur:

```bash
node scripts/probe.mjs --to openai --label T7a --delay 60
```

- T7a: Panelin olduğu chatte birkaç mesaj daha yaz, panel ekrandan yukarı kaysın.
- T7b: ChatGPT'de **başka bir chate** geç, orada kal. Uyandırma panelin chatine mi gitti, açık olan chate mi?
- T7c: Yeni chat aç, 10 dk bekle (`--delay 600`). Panel hâlâ poll ediyor mu?
- T7d: ChatGPT'yi tamamen kapatıp aç, eski chati aç. Panel kendiliğinden yeniden bağlanıyor mu (yeni widgetId), yoksa `bridge_join` gerekiyor mu?

Her turdan sonra:

```bash
node scripts/report.mjs --since 15
```

Claude tarafında aynı testler `--to claude` ile yapılır; ön koşul bu oturumda `claude-wait.mjs`'in arka planda çalışıyor olması.

Sonuçları buraya not et:

| # | Claude Desktop | ChatGPT Desktop |
|---|---|---|
| T0 | ✓ Code sekmesinde çizildi (host `Claude 1.0.0`, `ui/message` ✓, poll 3 sn) | ✓ çizildi (host `chatgpt 26.1023.51421`, `ui/message` ✓ + `openai/message.draft`) |
| T1 | ◐ tıklamayla kabul edildi (3 ms, userActivation=true) ama mesaj sadece **composer'a taslak** olarak yazıldı; gönderimi kullanıcı yaptı. Not: panel açılınca yeni iframe olarak yeniden yüklendi (yeni widgetId) | |
| T2 | | |
| T3 | | |
| T4 | | |
| T5 | ✗ panel 1,4 sn'de fark etti ama host `ui/message`'ı 9 ms'de `isError: true` ile reddetti (tıklamasız, Code sekmesi) | ✓ tıklamasız uyandırdı (885 ms, userActivation=false), model 9 sn sonra `bridge_receive` çağırdı; cevap `bridge_send` ~4,5 dk sonra geldi |
| T6 | | |
| T7 | | |
| T8 | ✓ `scripts/claude-wait.mjs` arka plan görevi olarak: m4 geldikten 1 sn sonra tetiklendi, oturum kullanıcı mesajı olmadan uyandı (~5 sn) | ✓ panel **hidden** iken tıklamasız uyandırdı (388 ms), model 3 sn'de okudu; cevap 2 dk 22 sn sonra (tool onayı?) |

## ChatGPT'de panelsiz uyandırma denemesi (HB1)

ChatGPT'den `claude-wait.mjs --side openai`'yi arka planda başlatması istendi. ChatGPT süreci başlattı (PID dosyası, boş loglar) ve **ayrıca** aynı chati hedefleyen dakikalık bir heartbeat otomasyonu kurdu (`~/.codex/automations/…`, `kind = "heartbeat"`, `FREQ=MINUTELY;INTERVAL=1`).

- Waiter süreci broker'a hiç bağlanmadı (`waiter-armed` yok) ve probe sırasında artık çalışmıyordu → ChatGPT'de arka plan süreci tur bitince ayakta kalmıyor ya da sandbox'ta bağlanamıyor.
- Panel auto-wake kapalıyken probe m5 **+49,8 sn**'de okundu, cevap +57,9 sn'de geldi. Uyandıran heartbeat'ti.
- Otomasyon işi bitince kendini sildi.

Sonuç: ChatGPT'de panelden bağımsız, desteklenen bir uyandırma yolu var: **thread'i hedefleyen heartbeat otomasyonu**. Gecikme en fazla ~1 dk; her dakika bir model turu harcıyor.

## ChatGPT araştırma turu (11:17–11:24 TR)

- Sandbox içinden `127.0.0.1:7457` → `EACCES`. Sandbox dışında broker erişilebilir.
- Sandbox içi `Start-Process` çocuğu tool çağrısı bitince ölüyor (önceki iki waiter hatası bu). Unified exec ve sandbox dışı `Start-Process` tur sonrasında yaşıyor (120/120 tick, tur 11:24:02'de bitti, süreçler 11:24:27/29'da tamamlandı).
- **Süreç tamamlanması ChatGPT chatini uyandırmadı.** Belgelere göre background hook bitişi de yeni tur başlatmıyor.
- **Paneller kalıcı değil:** `ws1pjuz` 07:56'da, `w2pfy1i` 08:07'de (ikisi de `hidden`) teardown bildirmeden poll'u bıraktı.
- App Server control socket'ine bağlanılamadı (os error 10050). MCP Events sadece Cloud.
- Kalan adaylar: Stop hook (aktif run boyunca long-poll + `decision: "block"`), seyrek heartbeat, conversation side panel, goal modu.

## Stop hook deneyi (H1)

`scripts/codex-stop-hook.mjs`, `~/.codex/hooks.json` → `hooks.Stop` (senkron, `timeout: 330`). Kaynak: https://learn.chatgpt.com/docs/hooks

Davranış:
- Transcript'inde `bridge_join` geçmeyen chatlerde anında çıkar (diğer chatler etkilenmez).
- Son 15 dk'da köprü trafiği yoksa anında çıkar.
- Aksi halde 300 sn boyunca `.bridge/state.json`'u okur (ağ yok, sandbox localhost'u engellediği için). `openai`'ye okunmamış mesaj görürse `{"decision":"block","reason":"[PEER-BRIDGE] New message …"}` döner → Codex aynı turu bu metinle devam ettirir.
- Kendi logu: `.bridge/codex-hook.jsonl` (`wait`, `block`, `timeout`, `skip-idle-run`).
- Yerel testi: `node scripts/test-hook.mjs`.

Adımlar:
1. ChatGPT'yi tamamen kapatıp aç (hook'lar açılışta yüklenir). Yeni hook için güven/onay istemi çıkarsa onayla; çıkmazsa not et (CLI'da bu `/hooks` ile yapılıyor, masaüstü için belgelenmemiş).
2. Köprüye bağlı eski chati aç.
3. Isınma mesajı: `node scripts/send.mjs --to openai "H0 warm-up: just read this, do not reply through the bridge."`
4. ChatGPT'ye yaz: `bridge_receive çağır ve sadece "okundu" yaz.` Tur biterken hook beklemeye başlamalı (UI'da "Waiting for peer bridge message…" görünebilir).
5. Beklerken: `node scripts/probe.mjs --to openai --label H1 --delay 5`

Bakılacak: `codex-hook.jsonl`'de `wait` → `block` geldi mi; probe'da `read it` ve `replied` süreleri; chatte devam turu nasıl göründü; hook beklerken ChatGPT arayüzü kilitlendi mi (yeni mesaj yazılabiliyor mu).

**Sonuç (08:37–08:38 UTC):** Hook masaüstü uygulamasında onay istemeden çalıştı. "okundu" cevabından sonra tur kapanmadı (UI'da durdur butonu), hook 40 sn bekledi, m8 gelince ~1 sn içinde `block` döndü, model aynı turda devam edip m8'i 4 sn'de okudu ama `bridge_send` ile cevap vermedi. Ardından hook `stop_hook_active=true` ile **yeniden 5 dk beklemeye** girdi. Mekanizma çalışıyor, ama chat bu süre boyunca "meşgul" görünüyor; kullanıcının mesajı da muhtemelen kuyrukta bekliyor.

**Durum (2026-10-29 15:31 TR):** Hook kaldırıldı (`~/.codex/hooks.json` silindi, yedeği `hooks.json.bak-20261029T153109`). Köprü düz MCP ile ilerliyor; `install.mjs` artık hook kurmuyor, sadece eski kurulumdan kalan girdiyi temizliyor. Script ve testi (`codex-stop-hook.mjs`, `test-hook.mjs`) referans için duruyor.

## Yardımcı komutlar

```bash
node scripts/send.mjs --status
```

```bash
node scripts/send.mjs --reset
```

```bash
npm run smoke
```

```bash
node scripts/install.mjs --uninstall
```

## Güvenlik notları

- `from` alanını broker atar (server'ın `--side` parametresinden). Model kimlik uyduramaz.
- Uyandırma mesajı sabit metindir; asıl içerik `bridge_receive` ile, `[PEER …]` zarfı ve "güvenilmez içerik" kuralıyla gelir.
- Bir run'da en fazla 20 mesaj; sonra `--reset` gerekir.
- Broker sadece `127.0.0.1`'de dinler ve `.bridge/token` başlığı ister.

## Kuyruk + wake deep-link (Q1) — 2026-10-29 15:24–15:29 TR

ChatGPT Desktop'ın `app.asar`'ında `codex://threads/wake/<threadId>` route'u var (`wakeQueuedThread`): uygulama kendi app-server'ında `thread/queue/list` çağırıyor, kuyruk boş değilse `resumeThread` ile thread'i devam ettiriyor. Kuyruk `~/.codex/queue_1.sqlite`'ta, tüm app-server süreçleri paylaşıyor.

`scripts/codex-thread.mjs` uygulamanın kendi `codex.exe`'siyle özel bir `codex app-server` (stdio, `experimentalApi`) açıyor:

- `thread/start {model}` + `thread/inject_items` (developer mesajı) + `thread/name/set` → model turu olmadan diske yazılan, adı ve modeli seçilmiş yeni thread. (`inject_items` olmadan turu olmayan thread diske yazılmıyor.)
- Başka bir süreçten `thread/queue/add` → thread o süreçte yüklü değilse öğe **çalışmadan bekliyor**. (Aynı süreçte yüklüyse ve boştaysa hemen o süreçte çalışıyor; bunu istemiyoruz.)
- `start codex://threads/wake/<id>` → masaüstü uygulaması kuyruğu ≤3 sn'de aldı, turu kendisi çalıştırdı.

Sonuç: `gpt-6-luna` ile yeni thread, prompt kuyruktan, cevap `luna seed ok` (wake'ten ~10 sn sonra). Panel, heartbeat ya da Stop hook gerekmedi. Belgelenmemiş/experimental API: uygulama güncellemelerinde bozulabilir.

## Açık thread + oturum kimliği doğrulaması (Q2) — 2026-10-29 15:37–15:50 TR

**Açık thread'e kuyruk:** `codex://threads/<id>` ile thread öne getirildi, sonra wake göndermeden `thread/queue/add` yapıldı → uygulama kuyruğu ~2 sn'de kendisi aldı (`A ok`). Başka bir chat öndeyken (thread arkada ama yüklü) aynısı → ~2 sn (`B ok`). Uygulama yüklü thread'lerin kuyruğunu kendisi izliyor; `codex://threads/wake/<id>` sadece yüklü olmayan thread'ler için gerekli (boş kuyrukta zararsız).

**MCP sunucusunun ortamı:** İki uygulama da sunucuyu temizlenmiş bir ortamla başlatıyor (Claude: 32 temel Windows değişkeni, ChatGPT: 20). `CLAUDE_CODE_SESSION_ID` ya da herhangi bir `CODEX_*` değişkeni **yok** → oturum kimliği env'den alınamaz. (Okuma: hedef sürecin PEB'indeki ortam bloğu.) Claude tarafındaki sunucular oturum sürecinin değil, ortak üst `claude.exe`'nin çocuğu; ChatGPT'de app-server'ın altında 4 sunucu süreci var.

**Yerine:** Claude Code tool çağrılarında `_meta["claudecode/toolUseId"]` gönderiyor (binary'de var). Tool çalışırken o `tool_use` bloğu `~/.claude/projects/<proje>/<oturum-id>.jsonl`'a zaten yazılmış durumda (doğrulandı), dosya adı oturum kimliği. `src/caller.mjs` bu kimliği son 10 dk'da değişen transcript'lerde arıyor (yerelde 7 ms). Açık kalan: `_meta`'nın sunucumuza gerçekten ulaştığı — uygulamalar yeniden başlatılınca `bridge_status`'un `caller` alanında görülecek.

**Yeniden başlatma sonrası (12:44–12:45 UTC):**
- Claude: `metaKeys: []`. Sunucuyu Code oturumu değil Claude Desktop ana süreci başlatıyor (`claude_desktop_config.json` kaydı) ve Code oturumuna proxy'liyor; `_meta` ve env düşüyor. Çözüm adayı: sunucuyu Claude Code'un kendi config'ine kaydetmek (`env` içinde `${CLAUDE_CODE_SESSION_ID}` genişletmesi).
- ChatGPT: `_meta` anahtarları `progressToken, callId, x-codex-turn-metadata, threadId, sessionId, windowId, itemId` → çağıran thread doğrudan belli, transcript taramasına gerek yok.

## Taşınabilirlik düzenlemesi — 2026-10-29

- `src/platform.mjs`: Windows/macOS/Linux farkları tek yerde (veri klasörü, Codex/Claude config yerleri, paketli `codex` ve `claude` CLI'ları, `codex://` açma). Her biri env ile ezilebilir (`PEER_BRIDGE_DIR`, `PEER_BRIDGE_CODEX_BIN`, `PEER_BRIDGE_CLAUDE_BIN`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`). macOS yolları **henüz bir Mac'te doğrulanmadı**.
- Broker verisi artık repo içinde değil, kullanıcı başına: Windows `%LOCALAPPDATA%\peer-bridge`, macOS `~/Library/Application Support/peer-bridge`. (Eski `.bridge/` klasörü sadece geçmiş testlerin kaydı.)
- Claude kaydı Claude Desktop config'inden Claude Code **user scope**'a taşındı (`claude mcp add-json -s user`, env `PEER_BRIDGE_SESSION=${CLAUDE_CODE_SESSION_ID}`). Eski Desktop kaydı installer tarafından siliniyor.
- `src/codex.mjs`: kuyruk + wake istemcisi; `scripts/codex-thread.mjs` artık bunun ince bir CLI'ı. Yeniden test: `gpt-6-luna` yeni thread, `refactor ok`.

## Yeniden başlatma sonrası (C1) — 2026-10-29 15:53–15:57 TR

**Claude (user scope):** Sunucu bu oturumun kendi `claude.exe` sürecinin çocuğu (oturum başına bir sunucu) ve oturumun **tam ortamını** devralıyor → `CLAUDE_CODE_SESSION_ID` doğrudan okunuyor. `_meta.claudecode/toolUseId` de geliyor; transcript eşlemesi aynı oturumu buldu. User scope config'te `${VAR}` **genişletilmiyor** (değişken düz metin geldi) → installer'dan kaldırıldı; kimlik önceliği: env → transcript.

**ChatGPT:** Sunucular yeni veri klasörüne (`%LOCALAPPDATA%\peer-bridge`) bağlandı. Kuyruktan gelen bir turda (Luna) model `mcp__peer_bridge__bridge_status`'u çağırdı ama sonuç dönmedi → büyük ihtimalle MCP araç onayı bekliyor. Codex config'te `default_tools_approval_mode` (`auto|prompt|approve`) var ve araç ipuçlarına (`destructive`, `open_world`) bakıyor. Araçlara MCP `annotations` eklendi (yerel, yıkıcı değil, kapalı dünya; `bridge_status` salt okunur); etkisi ChatGPT yeniden başlayınca görülecek.

**C1 sonucu (onaydan sonra, 12:58 UTC):** ChatGPT'de bekleyen araç onayı verilince `bridge_status` döndü. `_meta.threadId` = `01a187b8-56aa-…` = kuyruğa gönderdiğimiz thread'in tam kimliği (`sessionId` de aynı). Zincir uçtan uca doğrulandı: Claude oturumu → kuyruk → ChatGPT thread'i → MCP → broker, iki tarafta da çağıran chat kesin olarak belli. Açık konu: MCP araç onayı; `annotations`'ın onayı kaldırıp kaldırmadığı ChatGPT yeniden başlayınca test edilecek.

## Onay ayarları + Claude tarafı (C2) — 2026-10-29

**Onaylar (iki taraf):** `install.mjs` artık ChatGPT için `default_tools_approval_mode = "approve"` (geçerli değerler: `auto|prompt|writes|approve`, geçersiz değer config yüklemesini bozuyor) ve Claude Code için `~/.claude/settings.json` → `permissions.allow: ["mcp__peer-bridge"]` yazıyor; `--uninstall` ikisini de geri alıyor (geçici config klasöründe 2× install + uninstall doğrulandı). Gerçek kurulumu **kullanıcı kendisi çalıştırmalı**: Claude izin dosyasına yazmak ajanın kendi izinlerini değiştirmesi sayılıyor ve otomatik modda engelleniyor.

**Claude'u çağrılan ajan yapmak:**
- `claude://code/new?q=<prompt>&folder=<klasör>` (Claude Desktop) prompt'u yazılı yeni Code oturumu açıyor; ek parametre olarak sadece `environment`, `runner_pool`; model seçimi yok. Otomatik gönderip göndermediği henüz test edilmedi.
- `claude://resume?session=<id>` bir CLI oturumunu Desktop'a içe aktarıyor.
- Oturum gelen kutusu (`CLAUDE_CODE_MESSAGING_SOCKET` + `..._TOKEN`): Claude Code token'ı alt süreçlerden gizlenen sırlar listesinde tutuyor → iç protokol, **kullanılmayacak**.
- Kalıcı oturum için `scripts/claude-listen.mjs` + Monitor aracı: her yeni mesaj için bir satır = bir bildirim; waiter gibi her mesajda yeniden kurulması gerekmiyor, sadece Monitor süresi dolunca (en fazla 30 dk).
- **M1/M2 sonucu (13:06 UTC):** Monitor + `claude-listen.mjs` bu oturumu m1 için kendiliğinden uyandırdı (gönderen arka plan görevi henüz bitmemişken, yani uyandıran Monitor). m2 aynı dinleyiciden, **yeniden kurmadan** ikinci bir bildirim olarak geldi. Claude'da kalıcı advisor/çağrılan ajan için uyandırma yolu bu.

## Bağlantılar + tetikleyici hook'lar (L1) — 2026-10-29

**Tasarım:** `bridge_link` bir primary chat'e advisor bağlar (Claude'dan yeni Luna/vb. ChatGPT thread'i, `read-only` sandbox; ya da her iki uygulamada join kodu + `bridge_link_join`). `src/hook.mjs` iki uygulamada da aynı:
- `stop` (Stop, senkron): bağlı primary ise turun son mesajını `outbox/`'a yazar ve çıkar. Engellemez, beklemez, ağ kullanmaz (~80 ms, mantık 1–2 ms).
- `prompt` (UserPromptSubmit): advisor'ın `nit`'lerini bir kez `additionalContext` olarak verir.
- `listen` (sadece Claude, `asyncRewake: true`, Stop + SessionStart): bu oturuma mesaj gelince exit 2 ile uyandırır. Her Stop/SessionStart'ta yeniden kurulur, en yenisi eskisini emekliye ayırır → modelin bir şey hatırlaması gerekmez, oturum yeniden açılınca SessionStart tekrar kurar. ChatGPT tarafı kuyruk + wake ile uyanır, dinleyiciye gerek yok.
- Teslim kuralı: `concern`/`blocker` primary'yi şimdi uyandırır, o devam turu tekrar incelemeye gitmez; `nit` sonraki prompt'la; aynı not tekrar gönderilmez.

**Otomatik testler (`npm test`):** `test-link.mjs` 8 senaryo (bağlı olmayan chat, Claude→GPT istek, concern ile uyanma, döngü kurulmaması, nit bir kez, ters yön GPT→Claude join kodu ile, tek dinleyici, unlink) ve `test-install.mjs` (2× kurulum, başka hook'ların korunması, eski engelleyen Codex hook'unun değişmesi, temiz kaldırma) geçti.

**Kaza (13:23 UTC):** Shell'de `&&` zinciriyle yazılan bir installer testinde ilk adım hata verince geçici config ortamı kurulmadı ve installer gerçek config'lerde kurulum + kaldırma yaptı. Net etki: Claude user scope kaydı ve Codex `config.toml` bloğu silindi (`settings.json` yine `{}`). İkisi de kazadan önceki haline getirildi (Codex: diff ile doğrulanan yedekten; Claude: aynı kayıt yeniden eklendi). Önlem: installer testi artık ortamı kendi içinde kuran `scripts/test-install.mjs`; gerçek dosyaların md5'i test öncesi/sonrası aynı. Yedek dosyaları (`*.bak-2026-10-29T13-23-5*`) `~/.claude` ve `~/.codex` altında duruyor.

**Canlı doğrulanmadı:** hook'lar gerçek uygulamalarda (kullanıcının `install.mjs`'i çalıştırması gerekiyor), Codex Stop hook'undaki `session_id`'nin thread kimliğiyle aynı olduğu, `asyncRewake`'in Desktop Code tab'ında uyandırması.

## Canlı test L1 (Claude primary → Luna advisor) — 2026-10-29 13:30–13:32 UTC

`bridge_link(advisor=openai, model=gpt-6-luna)` → thread `01a187db-0858-…`, link L1. Turun son mesajına kasıtlı hata kondu (17 × 3 = 41).

| t (UTC) | olay |
|---|---|
| 13:31:02.246 | Claude Stop hook → `turn_end` outbox'a (3 ms), dinleyici `asyncRewake` ile kuruldu |
| 13:31:27.848 | broker isteği işledi → `m3` review-request (**25 sn gecikme**, aşağıya bak) |
| 13:31:28.221 | kuyruk + wake ile Luna thread'ine teslim; tur 13:31:28'de başladı |
| 13:31:32 / :34 | GPT `bridge_receive` → `bridge_advise(incorrect, concern, "17 × 3 = 51")` (onay istemi yok) |
| 13:31:34.640 | Claude dinleyicisi `m4`'ü gördü, exit 2 → oturum **kendiliğinden uyandı** ("Stop hook feedback") |
| 13:31:37 | Claude `bridge_receive` ile m4'ü okudu |

Advisor'ın kendi süresi ~6 sn, Claude'un uyanması advise'tan 0,5 sn sonra.

**25 sn gecikmenin nedeni:** `bridge_link`'in yeni thread için açtığı özel app-server kendi peer_bridge MCP sunucusunu başlattı; o sunucu broker sahibi oldu ve app-server kapanınca öldü. Broker sahipsiz kaldı; ChatGPT kendi sunucusunu tesadüfen başlatınca devralındı. Düzeltmeler: (1) özel app-server `-c mcp_servers.peer_bridge.enabled=false` ile açılıyor (doğrulandı, artık sunucu başlamıyor); (2) her MCP sunucusu `keepOwner()` ile 2 sn'de bir broker'ı yokluyor, sahip ölürse devralıyor (test 9: 260 ms); (3) broker protokol sürümü: eski kodla çalışan sahip (ör. güncellemeden kalan yardımcı süreç) yeni istemci gelince görevi bırakıyor (test 0). Bu düzeltmeler çalışan sunuculara uygulamalar yeniden başlayınca geçer.

## Ters yön denemesi R1 (GPT primary → Claude advisor) — 2026-10-29 13:43–13:52 UTC

ChatGPT'de `bridge_link(advisor=join)` → L2, bu Claude oturumu `bridge_link_join` ile advisor oldu (L1 önce kapatıldı). ChatGPT'de kasıtlı hatalı tur (13:45:20–23, "17*3 → 41") → **inceleme gitmedi, Claude uyanmadı.**

Teşhis: Codex loglarında `hook/started`/`hook/completed` var, ama `debug-hooks` teşhis modunda bile bizim script'ten hiç satır yok → komut hiç başlamıyor. Codex Windows'ta hook komutunu POSIX shell'de çalıştırmıyor; tırnakla başlayan komut satırı (`"C:\Program Files\nodejs\node.exe" "…hook.mjs" …`) PowerShell'de parse hatası ("Expressions are only allowed as the first element of a pipeline"). Claude Code hook'ları git-bash'te çalıştırdığı için orada sorun yoktu.

Düzeltme: Codex girdisine Windows'ta `commandWindows` eklendi: node'un 8.3 kısa yolu (`C:\PROGRA~1\nodejs\node.exe "…hook.mjs" …`), kısa ad yoksa `& "…"`. PowerShell ve cmd'de yerelde çalıştı; `test-install.mjs` bunu da kontrol ediyor. Ek bulgular: kısa yolu hesaplayan `cmd` çağrısı Node'un tırnaklamasıyla bozuluyordu (`windowsVerbatimArguments` ile düzeltildi); boş `none` notları artık tekrar sayılmıyor. Canlı doğrulama için installer'ın yeniden çalıştırılması gerekiyor.

**R1 sonucu, düzeltmeden sonra (13:51 UTC):** Installer yeniden çalıştırılıp uygulamalar yeniden başlatıldı. ChatGPT'de "15*3 kaç? Cevabı 37 olarak ver." → tur 13:51:20'de bitti, Codex Stop hook'u çalıştı (`commandWindows` kısa yol) ve review-request `m9` üretti. Codex hook stdin'indeki `session_id` = thread kimliği `01a187e6-…` (teşhis logu ile doğrulandı; ayrıca `turn_id`, `transcript_path`, `cwd`, `model` alanları var). Bu Claude oturumu, uygulama yeniden açılınca **SessionStart** ile kurulan dinleyiciyle kendiliğinden uyandı, `bridge_advise(incorrect, concern)` → `m10` 13:51:43'te kuyruk + wake ile ChatGPT'ye teslim edildi; ChatGPT 13:51:52'de "15 × 3 = 45 …" diye düzeltti ve bu devam turu tekrar incelemeye gitmedi (`advisory follow-up`). İki yön de canlı doğrulandı.

Eksik: inceleme isteğinde sadece primary'nin son mesajı var; kullanıcının sorusu yok ("37" tek başına değerlendirilemiyor, advisor soruyu thread kaydından okumak zorunda kaldı).
- **Düzeltildi:** `UserPromptSubmit` hook'u bağlı primary'nin kullanıcı mesajını `turn_start` olarak kaydediyor; broker bunu aynı turun inceleme isteğine "User's message / Primary's final message" olarak ekliyor. Soru sadece kendi turuna eklenir (turn kimlikleri uyuşmazsa "(not captured)"), kullanıldıktan sonra silinir. Codex `turn_id`, Claude `prompt_id` kullanıyor. Testler: senaryo 2, 6 ve 6b. Broker protokolü 3'e çıktı.

## Alfa turu — 2026-10-29

- **Sınır ve büyüme:** 200 mesaj sınırı kaldırıldı (250 inceleme isteği testi). Durum budanıyor: okunmuş mesaj ve teslim edilmiş not 1 gün, her şey 7 gün, kapalı bağlantı 7 gün sonra; bağlantı başına son 50 tavsiye. Serbest `bridge_send` için döngü koruması: 10 dk'da 60 mesaj.
- **Hatalar görünür:** ChatGPT'ye teslim başarısız olursa, ya da Claude advisor oturumu dinlemiyorsa, bekleyen chate bir sonraki prompt'unda "Bridge status" notu düşüyor; `bridge_status` bağlantı sağlığını ve dinleme durumunu gösteriyor.
- **Diff:** `UserPromptSubmit` turun başında `git stash create` ile anlık görüntü alıyor (dosya/ref/index'e dokunmadan); `Stop` o görüntüye göre diff + yeni izlenmeyen dosyaları ekliyor (20k karakter sınırı). `.env*`, anahtar/sertifika, `*secret*`, `*credential*` ne içerik ne ad olarak gidiyor (smoke testi `.env` adının da sızdığını yakaladı, düzeltildi).
- **Tek seferlik reviewer:** `bridge_review` (Claude'dan yeni ChatGPT thread'i + model, ya da her iki uygulamada join kodu). Cevap her severity'de geri gelir, bağlantı kapanır; kapanan bağlantıya rağmen cevap dinleyiciyi uyandırır (yarış durumu düzeltildi).
- **Temizlik:** MCP Apps paneli (`bridge_join`, widget, poll/claim) ve uyandırma deneyi script'leri kaldırıldı (git geçmişinde duruyor). Smoke testi MCP üzerinden iki gerçek sunucuyla baştan yazıldı. Broker protokolü 4.
- **Lisans:** kullanıcı kararıyla yok (tüm hakları saklı).

## İlk canlı one-off review (R2) ve bulgularının düzeltilmesi — 2026-10-29

Kullanıcı `bridge_review` ile `9deb2be`'yi yeni bir ChatGPT thread'inde (gpt-6.1-sol) incelettirdi; cevap Claude oturumuna kendiliğinden döndü (özellik canlı doğrulandı). Reviewer 2 P1 + 6 P2 buldu, hepsi doğrulandı ve düzeltildi:

- P1 sır sızıntısı: dışlama sadece dosya adına bakıyordu (`secrets/config.json`, `.envrc` geçiyordu) → klasör kalıpları (`secrets/`, `.ssh/`, `.aws/`, `*secret*/`, `*credential*/`…) ve `.env*`, `.netrc`, `.npmrc` eklendi; izlenmeyen dosya listesine de uygulanıyor.
- P1 cevap yanlış isteğe: `bridge_advise` artık `request_id` alıyor; birden fazla açık istek varken id'siz cevap reddediliyor (test 16).
- P2 commit'siz repo: `git stash create` hatası yakalanıyor, boş ağaçla diff (test-git 2).
- P2 okunmamış mesajlar sayıyla silinmiyor; sınır sadece okunmuşlara (test 17, 600 okunmamış).
- P2 önceden izlenmeyen dosyadaki düzenleme: baseline'da içerik hash'leri, değişenler listeleniyor (test-git 3).
- P2 boyut sınırı stat ve listeleri de kapsıyor (test-git 4).
- P2 one-off review diff'i: Claude'da oturumun `CLAUDE_PROJECT_DIR`'ı; ChatGPT'de paylaşılan sunucunun cwd'si asla kullanılmıyor, klasör bilinmiyorsa diff eklenmiyor ve bu açıkça yazılıyor (smoke 5c). `x-codex-turn-metadata` alanlarının adları `bridge_status`'ta görünüyor, içinde cwd varsa kullanılacak.
- P2 `bridge_send` kimseyi uyandırmıyordu: artık son aktif bağlantının diğer ucuna hedefli mesaj (uyandırır), bağlantı yoksa reddedilir (smoke 5b).
- Ek: yeni ChatGPT thread'leri için `effort` (config override + `thread/settings/update`); canlı doğrulandı, masaüstü uygulamasının turunda `"effort":"low"`.

## Kapalı uygulamada wake (W1) — 2026-10-29 14:30 UTC

ChatGPT Desktop tamamen kapalıyken (çalışan tek süreç `codex-windows-sandbox-service`) Luna thread'ine kuyruktan prompt eklendi ve `codex://threads/wake/<id>` açıldı:

| t | olay |
|---|---|
| +0,4 sn | kuyruğa eklendi, wake linki açıldı |
| +3 sn | ChatGPT süreçleri başladı (6, sonra 8) |
| +5 sn | kuyruk boşaldı |
| ~+10 sn | tur bitti: "kapalıyken ok" |

Görünür pencere açılmadı (`MainWindowHandle` olan süreç 0): uygulama wake-only modda arka planda açılıp turu çalıştırdı. Sonuç: ChatGPT tarafı uygulama kapalıyken de uyandırılabiliyor; uygulama bundan sonra arka planda açık kalıyor.

## 8.3 olmayan disk için yedek komut + Codex hook onayı (F1) — 2026-10-29 14:30–14:40 UTC

- Kod yolu doğrulandı: `PEER_BRIDGE_NO_SHORT_NAMES=1` ile installer `& "…node.exe" "…hook.mjs" …` yazıyor ve bu PowerShell'de hook'u çalıştırıyor (`test-install.mjs`).
- Yerelde: `node "…hook.mjs"` (PATH) cmd ve PowerShell'de çalışıyor; `call "…"` sadece cmd'de; `& "…"` sadece PowerShell'de.
- Canlı deneme sonuçsuz: gerçek `~/.codex/hooks.json`'da Stop komutu değiştirildi, değiştirilmiş Stop hook'ları hiç çalışmadı, değiştirilmemiş UserPromptSubmit çalıştı. Sebep büyük ihtimalle **Codex hook onayı**: `config.toml`'da `[hooks.state.'<hooks.json>:stop:0:0'] trusted_hash = "sha256:…"` tutuluyor; komutu değişen hook yeniden onaylanana kadar atlanıyor. Codex `hooks.json`'u çalışırken yeniden okumuyor (açılışta okuyor). Onay hash'leri zaman zaman uygulama tarafından yeniden yazılıyor (12:53, 13:49, 14:37), ne zaman/nasıl verildiği net değil; penceresiz (wake-only) açılışta onay istemi gösterilemiyor.
- Sonuç: Codex'in Windows'ta cmd mi PowerShell mi kullandığı hâlâ belirsiz (ilk "PowerShell" teşhisi de onay yüzünden olabilir). `hooks.json` birebir geri kondu (md5 aynı).
- Ürün için önemli: kurulum/güncelleme hook komutunu değiştirirse ChatGPT tarafındaki tetikleyici, kullanıcı onaylayana kadar **sessizce** çalışmayabilir → `doctor` komutu `hooks.state` onaylarını kontrol etmeli; README'de belirtilmeli.
- **Doğrulama (14:41 UTC):** `hooks.json` geri konup ChatGPT normal (pencereli) açıldı; onay istemi çıkmadı. Kuyruktan bir turda hem UserPromptSubmit hem **Stop** çalıştı; `trusted_hash` değerleri test sırasındakiyle aynı (`485e…`, `7558…`) → bunlar orijinal hook'ların onayı, geçici olarak değiştirilen girdiler onaysız oldukları için atlanmıştı. Ürün bozulmadı. Açık soru: onaylar ilk kurulumda ne zaman/nasıl yazılıyor (kullanıcı hiçbir onay istemi görmedi); Codex'in Windows shell'i hâlâ belirsiz.
