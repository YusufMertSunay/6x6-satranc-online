# Üçüncü taraf lisansları

## Fairy-Stockfish (`engine/fairy-stockfish`)

Bu projede satranç hamlelerinin yasallığını denetlemek için
[Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish)
motorunun derlenmiş (binary) hâli, **değiştirilmeden**, ayrı bir alt süreç
olarak kullanılmaktadır.

Fairy-Stockfish, **GNU General Public License v3 (GPLv3)** ile
lisanslanmıştır. Lisansın tam metnine şu adresten ulaşabilirsiniz:
https://www.gnu.org/licenses/gpl-3.0.html

Kaynak kodu şu adreste herkese açıktır:
https://github.com/fairy-stockfish/Fairy-Stockfish

Bu proje, Fairy-Stockfish'i kendi kaynak koduna gömmeden (statik/dinamik
bağlama yapmadan), yalnızca standart giriş/çıkış (UCI protokolü) üzerinden
ayrı bir işlem olarak çalıştırmaktadır. Motorun kendisinde herhangi bir
değişiklik yapılmamıştır — sadece `engine/variants.ini` dosyası aracılığıyla
motorun zaten desteklediği "özel varyant" yapılandırma mekanizması
kullanılarak 6x6 varyantı tanımlanmıştır.

Bu kullanım biçimi, lichess.org gibi büyük platformların Stockfish'i kendi
sunucularında nasıl kullandığıyla aynıdır ve GPLv3'ün "ayrı program olarak
çalıştırma" (mere aggregation / separate process) kapsamına girer — bu
projenin kendi kaynak kodunun (server.js, lib/, public/) GPL'e tabi olmasını
GEREKTİRMEZ.

Yine de GPLv3'ün gerekliliklerine uymak adına:

1. Bu dosya, motorun lisansını ve kaynağını açıkça belirtmektedir.
2. Motor değiştirilmeden, olduğu gibi dağıtılmaktadır.
3. Kaynak koduna yukarıdaki bağlantıdan herkes ulaşabilir.

Eğer ileride Fairy-Stockfish'in kendi kaynak kodunda bir değişiklik
yapıp onu bu haliyle dağıtırsanız, o değişikliklerin kaynak kodunu da
GPLv3 gereği paylaşmanız gerekir. Şu anki haliyle (sadece `variants.ini`
yapılandırması) böyle bir yükümlülük söz konusu değildir.
