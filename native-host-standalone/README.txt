Shahjahan Download Manager — Native Host 1.0.2 (Windows)
=========================================================

Ye chhota package is liye hai: Chrome extension ko desktop app se
jorne ke liye Windows registry me native host register hona zaroori
hai. Installed/portable app ye kaam khud nahi karti, is liye ye
standalone host diya ja raha hai. Is me sirf Node.js chahiye, koi
aur dependency nahi hai.

Install karne ka tareeqa
------------------------
1. Ye folder kahin stable jagah rakho (misal: C:\DownloadManagerHost).
   Baad me is folder ko move ya delete mat karna — Chrome isi path
   se host chalata hai.
2. Pehle Shahjahan Download Manager 1.0.2 app kholo (bridge app ke
   chalne par hi kaam karta hai).
3. install.bat par double-click karo.
   - Agar "Unknown Publisher" warning aaye to Run dabao — ye normal
     hai, file signed nahi hai. "Run as administrator" ki zaroorat
     nahi hai, ye setting sirf tumhare user account me hoti hai.
   - Window me Extension ID pehle se likhi hui milegi (tumhare PC
     wali ID) — sahi hai to sirf Enter dabao. Kisi aur PC par ho to
     apni ID paste karo.
   - ID ghalat ho ya khali Enter dabao to window band nahi hogi,
     wo dobara ID poochega. Paste karte waqt aane wale space/quote
     khud hat jayenge.
4. Script manifest + registry key bana dega. Phir:
   - chrome://extensions par extension ko Reload karo.
   - Jis page par video/download chahiye, us tab ko Reload karo
     (content script sirf naye page load par lagta hai — isi liye
     pehle "Receiving end does not exist" error aata hai).
   - Extension popup kholo — "Connected" likha aana chahiye.

Agar "Not connected" phir bhi aaye to check karo:
- Kya desktop app 1.0.2 waqai chal rahi hai? (Bridge band ho to host
  "app_not_running" jawab dega.)
- Kya extension ID bilkul sahi likhi thi? Ghalat ID par Chrome host
  ko bulata hi nahi.
- Kya Node.js installed hai? (node --version command se check karo.)

Edge ke liye
------------
install.bat ki jagah command prompt me ye chalao:
  node host.cjs install <extension-id> --browser edge

Uninstall
---------
uninstall.bat chalao — registry key hat jayegi. Folder phir delete
kar sakte ho.

Ye host kya karta hai (imaandari se)
-------------------------------------
Ye host khud kuch download nahi karta. Wo sirf extension ke messages
(ping, list, add_download, pause/resume/cancel) ko tumhare PC par
chal rahi desktop app ke loopback bridge tak pohunchata hai, usi
protocol v1 se jo app khud use karti hai. Auth cookies/headers sirf
memory me rehte hain, kabhi save nahi hote.
