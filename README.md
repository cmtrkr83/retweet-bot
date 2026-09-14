# Twitter Auto Retweet - Chrome Eklentisi

Belirli bir Twitter/X hesabının son tweetini otomatik olarak retweet eden Chrome eklentisi.

## ✨ Özellikler

- 🔄 **Otomatik Retweet**: Seçtiğiniz sıklıkta (15/30/60 dk) belirttiğiniz hesabın tweetlerini retweet eder
- 🔢 **Ayarlanabilir Sayı**: 1-10 arası geriye dönük tweet sayısı seçebilirsiniz
- 🎯 **Tweet Tipi Seçimi**:
  - Sadece orijinal tweetler
  - Sadece kullanıcının retweet ettikleri
  - Her ikisi birden
- 💾 **Geçmiş Kaydı**: Hangi tweetlerin retweet edildiğini kaydeder (tekrar retweet etmez, son 200 kayıt tutulur)
- 🎯 **Akıllı Kontrol**: Aynı tweeti birden fazla kez retweet etmez
- 🤖 **İnsan Benzeri**: Rastgele gecikmelerle doğal davranış sergiler
- 📊 **İstatistikler**: Toplam retweet sayısı ve son kontrol zamanı
- 🖱️ **Manuel Kontrol**: İstediğiniz zaman manuel kontrol yapabilirsiniz

## 📦 Kurulum

### Adım 1: Dosyaları İndirin
Tüm eklenti dosyalarını bir klasöre kaydedin:
- manifest.json
- background.js
- popup.html
- popup.js
- icon16.png
- icon48.png
- icon128.png

### Adım 2: Chrome'a Yükleyin

1. Chrome tarayıcınızı açın
2. Adres çubuğuna `chrome://extensions` yazın ve Enter'a basın
3. Sağ üst köşede **"Geliştirici modu"** (Developer mode) seçeneğini açın
4. **"Paketlenmemiş uzantı yükle"** (Load unpacked) butonuna tıklayın
5. Eklenti dosyalarının bulunduğu klasörü seçin
6. Eklenti yüklendi! ✅

## 🚀 Kullanım

### İlk Kurulum

1. Chrome araç çubuğunda eklenti ikonuna (🔄) tıklayın
2. **"Takip Edilecek Kullanıcı Adı"** alanına Twitter kullanıcı adını girin
   - Örnek: `elonmusk` (@ işareti olmadan)
3. **"Kontrol Sıklığı"** seçeneğinden 15 / 30 / 60 dakika seçin
4. **"Geriye Dönük Kaç Tweet Retweet Edilsin?"** seçeneğinden istediğiniz sayıyı seçin
   - Örnek: Son 3 tweeti retweet etmek için "Son 3 tweeti" seçin
5. **"Hangi Tweetler Retweet Edilsin?"** bölümünden istediğiniz tipi seçin:
   - **Sadece kendi yazdığı tweetler**: Kullanıcının orijinal tweetleri
   - **Sadece retweet ettikleri**: Kullanıcının başkalarından retweet ettikleri
   - **Her ikisi**: Hem orijinal tweetler hem de retweetler
5. **"Kaydet"** butonuna tıklayın

### Otomatik Çalışma

- Eklenti seçtiğiniz sıklıkta (15/30/60 dk) otomatik olarak kontrol yapar
- Yeni tweet varsa ve daha önce retweet edilmemişse otomatik retweet eder
- Reply'ler ve reklam/promoted tweet'ler atlanır

### Manuel Kontrol

- **"Şimdi Kontrol Et"** butonuna tıklayarak anında kontrol yapabilirsiniz
- İstatistikleri görmek için eklenti popup'ını açın

## ⚙️ Nasıl Çalışır?

1. **Zamanlayıcı**: Chrome Alarms API ile seçilen sıklıkta (15/30/60 dk) tetiklenir
2. **Sayfa Kontrolü**: Belirtilen kullanıcının Twitter profiline gider (varsa açık sekmeyi kullanır, yoksa gizli sekme açar)
3. **Tweet Bulma**: `article[data-testid="tweet"]` ile en yeni tweetleri bulur
4. **Filtreleme**: Reklam, reply ve geçmişte retweet edilenleri + tweet tipi (orijinal/retweet/ikisi) ayarına göre eler
5. **Retweet**: `data-testid="retweet"` + `retweetConfirm` butonlarına insan benzeri gecikmelerle tıklar
6. **Kayıt**: Tweet ID'sini kaydeder (tekrar retweet etmemek için, son 200 kayıt)

## 🔒 Güvenlik ve Gizlilik

- ❌ **API kullanmaz** - Token veya şifre gerektirmez
- ✅ Sadece tarayıcınızda çalışır
- ✅ Verileriniz sadece Chrome'un yerel depolama alanında tutulur
- ✅ Hiçbir veri dışarı gönderilmez
- ✅ Açık kaynak - kodu inceleyebilirsiniz

## ⚠️ Önemli Notlar

1. **Twitter/X Oturum Açık Olmalı**: Tarayıcınızda Twitter/X'te oturum açmış olmanız gerekir
2. **Sekme Açık Olabilir**: Twitter/X sekmesi kapalı olsa bile çalışır (gerekirse yeni sekme açar)
3. **Rate Limiting**: Twitter'ın bot karşıtı sistemlerine takılmamak için insan benzeri gecikmeler eklenmiştir
4. **Saatlik Kontrol**: Seçtiğiniz sıklıkta (15/30/60 dk) bir kez kontrol eder (spam'den kaçınmak için)

## 🛠️ Sorun Giderme

### "Tweet bulunamadı" Hatası
- Kullanıcı adının doğru olduğundan emin olun (@ işareti olmadan)
- Twitter/X sayfasının tamamen yüklendiğinden emin olun

### Yanlış Kullanıcının Tweeti Retweet Ediliyor
- Tweet tipi ayarını kontrol edin (sadece orijinal / sadece retweet / her ikisi)
- Reply'ler görmezden gelinir
- Eğer sorun devam ediyorsa, eklentiyi kaldırıp tekrar yükleyin

### "Retweet butonu bulunamadı" Hatası
- Sayfayı yenileyin
- Twitter oturumunuzun açık olduğunu kontrol edin

### Otomatik Retweet Çalışmıyor
- Eklentinin aktif olduğunu kontrol edin (`chrome://extensions`)
- Chrome'un arka planda çalıştığından emin olun
- Bilgisayarınızın internet bağlantısını kontrol edin

## 📝 Lisans

Bu proje kişisel kullanım için oluşturulmuştur. Dilediğiniz gibi değiştirebilir ve kullanabilirsiniz.

## 🤝 Katkıda Bulunma

Önerileriniz ve geliştirme fikirleriniz için issue açabilirsiniz.

---

**Not**: Bu eklenti Twitter/X'in kullanım şartlarına uygun olarak kullanılmalıdır. Spam veya kötüye kullanımdan kaçının.
