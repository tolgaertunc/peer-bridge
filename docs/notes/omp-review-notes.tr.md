# oh-my-pi (omp): reviewer ve advisor nasıl çalışıyor

İncelenen: https://github.com/can1357/oh-my-pi, `b075692` (2026-10-29). Kaynaklar: `docs/advisor-watchdog.md`, `packages/coding-agent/src/advisor/*` (~4.100 satır), `src/session/session-advisors.ts` (~3.100 satır), `src/prompts/advisor/system.md`, `src/prompts/advisor/advise-tool.md`, `src/prompts/agents/reviewer.md`, `src/extensibility/custom-commands/bundled/review/*`, `src/prompts/review-request.md`.

## Temel fark: omp döngünün sahibi

omp'de primary ajan da, reviewer da, advisor da **aynı harness'in içinde** çalışıyor. "Primary'nin transcript'ine mesaj ekle" ya da "primary'yi yeni tura başlat" birer fonksiyon çağrısı. Uyandırma problemi diye bir şey yok.

Bizim durumumuzda iki kapalı uygulamanın dışındayız. Panel, Stop hook ve waiter, döngünün sahibi olmadığımız için bulduğumuz geçici yollar. Panelin "tam oturmaması" bu yüzden yerinde bir his.

omp'de iki ayrı mekanizma var.

## 1. `/review`: isteğe bağlı, tek seferlik reviewer

- Primary, diff'i (branch, commit ya da commit edilmemiş iş) hazırlıyor ve `task` tool'u ile **paralel reviewer subagent'ları** başlatıyor. Dosyalar yakınlığa göre gruplanıyor.
- Reviewer ayrı bir agent tanımı (`agents/reviewer.md`): yavaş/güçlü model (`@slow`), salt okunur araçlar, kendi `scout` alt ajanı.
- Çıktısı **yapılandırılmış**:
  - `overall_correctness: correct | incorrect`
  - `explanation`: 1–3 cümle
  - `confidence`: 0–1
  - `findings[]`: her biri `title` (≤80 karakter), `body` (hata, tetikleyici, etki), `priority` P0–P3, `confidence`, `file_path`, `line_start`/`line_end`
- Sıkı raporlama kriterleri: kanıtlanabilir etki, uygulanabilir düzeltme, kasıt dışı, **patch'in getirdiği** sorun, varsayımsız.
- "Cross-boundary" kuralı: patch'in yeni ürettiği her mesaj, olay ya da enum değeri için tüketici tarafındaki dispatch noktası okunmalı. Sessizce düşürülen değerler en çok kaçırılan hata türü.
- Akış **pull** tabanlı: primary başlatıyor, sonuç tool sonucu olarak dönüyor. Kimsenin uyandırılması gerekmiyor.

## 2. Advisor / watchdog: sürekli gölge reviewer

### Rol
- Primary'ye bağlanan, kendi bağlamı ve kendi araç oturumu olan **ayrı bir agent**. Varsayılan araçlar salt okunur: `read`, `grep`, `glob`.
- **Peer değil.** Mesaj atılamıyor, broadcast'e dahil değil. Primary'nin işini onaylamıyor, durumunu değiştirmiyor. Tek çıkış kanalı `advise` tool'u.
- Birden fazla advisor tanımlanabiliyor (`WATCHDOG.yml` roster'ı), her birinin modeli, araçları ve uzmanlık talimatı ayrı. Paylaşılan reviewer rehberi `WATCHDOG.md`'de; bu metin sadece advisor'a gidiyor, primary'nin bağlamına girmiyor.

### Neyi görüyor
- Her primary sınırında, son incelemeden beri oluşan **transcript delta'sını** alıyor: reasoning, tool çağrıları ve sonuçları dahil. Tüm geçmiş her seferinde gönderilmiyor.
- Advisor'ın kendi notları sonraki delta'dan çıkarılıyor; böylece kendi tavsiyesini incelemiyor.
- Compaction ya da oturum değişiminde advisor sıfırlanıyor ve güncel transcript'ten yeniden başlıyor.

### Ne zaman inceliyor
- `reviewMode: turn`: her primary turu (tool döngüsü adımları dahil).
- `reviewMode: agent-end`: sadece final cevaplarda, yani run başına bir kez.
- `reviewInterval: N`: her N'inci uygun güncellemede; atlananlar biriktirilip sonraki incelemeyle gönderiliyor.

### Ne söylüyor: `advise(note, severity)`

| Severity | Anlamı | Teslim |
|---|---|---|
| `nit` (varsayılan) | Temizlik, sadeleştirme | Bir sonraki tur sınırında araya giriyor; final cevaptan sonra sadece görünür kart oluyor |
| `concern` | Yanlış yöne gidiyor olabilir, önemli bir şey kaçıyor | Mümkünse araya giriyor; final cevaptan sonra **bir** devam turu istiyor |
| `blocker` | Devam etmek açıkça boşa iş ya da bozuk çıktı | Canlı turu kesebiliyor |

Primary'ye XML-escape edilmiş olarak gidiyor:

```text
<advisory advisor="Architecture" severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

### Teslim politikası: severity × primary'nin durumu
- **Primary hâlâ çalışıyorsa:** sadece `blocker` canlı turu yönlendirebiliyor. `nit`/`concern` final sınıra kadar bekliyor.
- **Primary final cevap verip boşa düştüyse:** `advisor.continueSeverity` (varsayılan `concern`) ve üstü tek bir devam turu açıyor. Altındaki notlar görünür kart olarak kalıyor ve **kullanıcının bir sonraki mesajıyla** primary'ye ulaşıyor.
- **Primary iş ortasında durduysa:** `concern`/`blocker` yeni tur başlatıyor.
- **Kullanıcı bilerek durdurduysa (Esc):** advisor otomatik devam ettirmiyor; not kart olarak saklanıyor.
- **Plan modunda:** her şey kart olarak kalıyor.

### Sınırlar ve gürültü kontrolü
- **Emission guard:** metni normalize edip tekrarları atıyor (aynı ya da daha düşük severity'de). İçeriksiz notları ("lgtm", "done", "no issue continue") susturuyor. İnceleme başına en fazla N (varsayılan 4) non-blocker not kabul ediyor; blocker'lar muaf.
- **`immuneTurns` (varsayılan 3):** araya giren bir concern'den sonra, birkaç tur boyunca yeni concern'ler araya girmiyor, sadece "aside" oluyor.
- **Cascade önleme:** Advisor'ın başlattığı devam turu yeni bir inceleme planlamıyor. Advisor → primary → advisor döngüsü kurulamıyor.
- **`syncBacklog` (`off` / `1` / `3` / `5` / `strict`):** primary tur sonunda advisor'ın yetişmesini bekliyor. Sayısal değerlerde bekleme en fazla 30 sn; `strict`'te limit yok. `agent-end` + `strict` = **senkron final inceleme**: primary final sınıra geliyor, advisor tüm run'ı inceliyor, primary ancak ondan sonra bitiyor.
- **Hata dayanıklılığı:** advisor hata verirse primary takılmıyor (yeniden deneme, model fallback, en sonda bırakma). Zararlı çıktı (yıkıcı komut, talimat ezme) tool çalıştırılmadan karantinaya alınıyor.

### Advisor prompt'undan dikkat çekenler (`prompts/advisor/system.md`)
- "Ajan doğru yoldaysa sessizlik tercih edilir."
- Kullanıcı niyetini ya da kapsamı sorgulamak yasak; alanı doğruluk, edge case, tasarım, yürütme stratejisi ve doğrulama.
- Ajanın zaten bildiği şeyi (görülen hatalar, başarısız testler) tekrar söylemek yasak; aynı tavsiyeyi iki kez vermek yasak.
- Sadece transcript'teki ya da kendi araçlarıyla gördüğü kanıta dayanabilir.
- `blocker` kriterleri somut: açık talimatı çiğnemek, stub/mock ile "bitti" demek, test yeşil olmadan teslim etmek vb.

## Bizim köprü için çıkarımlar

### 1. "İki eşit peer" yerine "primary + advisor" rolleri

omp'nin en önemli tasarım kararı advisor'ın **peer olmaması**. Bu bizim üç sorunumuzu birden çözüyor:
- **Uyandırma ihtiyacı küçülüyor.** Primary'nin boştan uyandırılması gerekmiyor; tavsiye primary'nin **kendi tur sınırında** teslim ediliyor. Uyandırılması gereken tek taraf advisor.
- **"Cevap göndereyim mi?" sorunu kalkıyor.** Advisor'ın tek çıkışı `advise`; sohbet etmiyor. Primary de tavsiyeyi `<advisory guidance="weigh, don't blindly obey">` olarak alıyor, yani karar insanın görevine bağlı kalıyor.
- **Döngü riski küçülüyor.** Cascade kuralı, tek devam turu ve cooldown hazır desen.

### 2. Ölçtüğümüz asimetri bu rollere birebir oturuyor

| | Boştan uyandırılabiliyor mu | Kendi tur sınırında bekleyebiliyor mu |
|---|---|---|
| Claude Code | ✓ arka plan waiter'ı, güvenilir | ✓ Stop hook var |
| ChatGPT Desktop | ◐ sadece panel (kalıcı değil) ya da heartbeat (pahalı) | ✓ Stop hook ölçüldü: 1 sn'de devam ettiriyor |

O yüzden **ChatGPT = primary, Claude = advisor** düzeninde panele hiç gerek kalmıyor:

```
ChatGPT turu biter
 └─ Codex Stop hook: son cevabı (ve gerekirse diff'i) broker'a delta olarak yazar, sınırlı bekler (ör. 60–90 sn)
      └─ broker → Claude waiter tetiklenir → Claude Code uyanır
           └─ Claude salt okunur araçlarla inceler → bridge_advise(note, severity) ya da sessiz kalır
      └─ Hook:
           concern/blocker → {"decision":"block","reason":"<advisory severity=…>…</advisory>"} (tek devam turu)
           nit / sessizlik / zaman aşımı → tur biter; nit'ler "kart" olarak saklanır
 └─ Kullanıcının sonraki mesajında: UserPromptSubmit hook'u saklanan notları ek bağlam olarak ekler
```

Bu, Stop hook'u omp'nin `agent-end` + `syncBacklog` desenine çeviriyor. Hook artık "herhangi bir mesaj gelir mi?" diye 5 dakika açık beklemiyor; **bu turun incelemesini** sınırlı bir süre bekliyor. Kendini zincirlemiyor (cascade kuralı). Senin itirazının büyük kısmı bu şekilde karşılanıyor.

Ters yön (Claude = primary, ChatGPT = advisor) aynı desenle çalışır: Claude Code Stop hook'u ChatGPT'nin incelemesini bekler. Ama ChatGPT'nin uyandırılması gerektiği için yine panele ya da heartbeat'e bağlı kalır.

### 3. Doğrudan alınabilecek parçalar
- **Severity modeli** (`nit` / `concern` / `blocker`) ve "severity × primary durumu" teslim tablosu.
- **Judge modu için `/review` şeması:** `correct`/`incorrect` + gerekçe + güven + P0–P3 bulgular. Serbest metin yerine yapılandırılmış verdict.
- **Delta gönderimi:** her incelemede tüm sohbet değil, son incelemeden beri olanlar.
- **Emission guard:** tekrar ve "lgtm" gürültüsünü broker'da filtrelemek; inceleme başına not bütçesi.
- **Cascade önleme ve cooldown:** tavsiyenin açtığı devam turu yeni inceleme tetiklemez.
- **Kullanıcı durdurursa otomatik devam yok;** not saklanır, sonraki mesajla teslim edilir.
- **`WATCHDOG.md` karşılığı:** proje bazında, sadece reviewer'ın gördüğü bir rehber dosyası.
- **Advisor prompt'undaki kurallar:** sessizlik varsayılan, niyet ve kapsam sorgulanmaz, sadece kanıt.

### 4. Modlara yansıması
- **judge:** `/review` deseni. Tek seferlik, yapılandırılmış verdict.
- **review:** advisor deseni, `agent-end` + sınırlı senkron bekleme.
- **second opinion:** judge'ın bulgusuz hali; bağımsız cevap + karşılaştırma.
- **debate / pair:** gerçekten iki peer gerektiren tek modlar. Her iki tarafın da boştan uyandırılmasını istiyor; panel/heartbeat sorunu sadece bunlarda kalıyor.
