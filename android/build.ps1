<#
.SYNOPSIS
  Kick Report Android uygulamasını (TWA) derler: imzalı APK (telefona kurmak için) ve AAB (Play Store için).

.EXAMPLE
  .\build.ps1 -Domain kickreport.com     # alan adını kaydeder ve derler
  .\build.ps1                            # twa.properties'teki alan adıyla tekrar derler

.NOTES
  İlk çalıştırmada keystore\ klasöründe imza anahtarı oluşturulur. BU KLASÖRÜ YEDEKLE:
  anahtar kaybolursa Play Store'daki uygulama bir daha güncellenemez (Play App Signing kullanılmıyorsa).
#>
param([string]$Domain)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding $false   # BOM'suz (Java .properties dosyaları BOM sevmez)

function Read-Props([string]$file) {
  $h = @{}
  if (Test-Path $file) {
    foreach ($line in [IO.File]::ReadAllLines((Resolve-Path $file), $utf8)) {
      if ($line -match '^\s*([^#=\s][^=]*?)\s*=\s*(.*)$') { $h[$matches[1]] = $matches[2].Trim() }
    }
  }
  return $h
}
function Write-Lines([string]$file, [string[]]$lines) {
  [IO.File]::WriteAllLines((Join-Path $PSScriptRoot $file), $lines, $utf8)
}
function Step([string]$msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

# 1. Alan adı -------------------------------------------------------------
if ($Domain) {
  $d = $Domain.Trim().ToLower() -replace '^https?://', '' -replace '/.*$', ''
  if ($d -notmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') { throw "Geçersiz alan adı: $Domain" }
  $lines = [IO.File]::ReadAllLines((Resolve-Path 'twa.properties'), $utf8) | ForEach-Object { if ($_ -match '^host=') { "host=$d" } else { $_ } }
  Write-Lines 'twa.properties' $lines
}
$props = Read-Props 'twa.properties'
$hostName = $props['host']
if (-not $hostName) { throw 'Alan adı yok. Kullanım: .\build.ps1 -Domain alanadin.com' }
$version = $props['versionName']
Step "Alan adı: https://$hostName/  (sürüm $version, kod $($props['versionCode']))"

# 2. Java (Android Studio'nun JDK'sı tercih edilir) -------------------------
$jbr = 'C:\Program Files\Android\Android Studio\jbr'
if (Test-Path "$jbr\bin\java.exe") { $env:JAVA_HOME = $jbr }
elseif (-not $env:JAVA_HOME) { throw 'JDK bulunamadı. Android Studio kur ya da JAVA_HOME ayarla (JDK 17 veya üstü).' }
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'

# 3. Android SDK ----------------------------------------------------------
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path $sdk)) { throw "Android SDK bulunamadı: $sdk. Android Studio'yu bir kez açıp SDK'yı kur." }
Write-Lines 'local.properties' @("sdk.dir=$(($sdk -replace '\\', '\\') -replace ':', '\:')")

# 4. İmza anahtarı (yoksa oluştur) ------------------------------------------
$ksProps = 'keystore\keystore.properties'
if (-not (Test-Path $ksProps)) {
  Step 'İmza anahtarı oluşturuluyor (ilk derleme)'
  New-Item -ItemType Directory -Force 'keystore' | Out-Null
  $bytes = New-Object byte[] 18
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $pass = [Convert]::ToBase64String($bytes) -replace '[+/=]', 'x'
  & $keytool '-J-Duser.language=en' -genkeypair -noprompt -storetype PKCS12 `
    -keystore 'keystore\kickreport-release.jks' -alias kickreport -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass $pass -keypass $pass -dname 'CN=Kick Report, O=Kick Report, C=TR'
  if ($LASTEXITCODE) { throw 'İmza anahtarı oluşturulamadı.' }
  Write-Lines $ksProps @(
    '# Kick Report imza anahtarı. Bu klasörü güvenli bir yere yedekle ve kimseyle paylaşma.',
    'storeFile=keystore/kickreport-release.jks', "storePassword=$pass", 'keyAlias=kickreport', "keyPassword=$pass")
}
$ks = Read-Props $ksProps
$listing = & $keytool '-J-Duser.language=en' -list -v -keystore (Join-Path $PSScriptRoot $ks['storeFile']) -alias $ks['keyAlias'] -storepass $ks['storePassword']
if ($LASTEXITCODE) { throw 'İmza anahtarı okunamadı (keystore.properties şifresi yanlış olabilir).' }
$sha = ($listing | Select-String 'SHA256:\s*([0-9A-F:]{95})').Matches[0].Groups[1].Value
Write-Lines 'keystore\sha256.txt' @($sha)
Step "İmza parmak izi (SHA-256): $sha"

# 5. Derleme --------------------------------------------------------------
Step 'Derleniyor (ilk seferde bağımlılıklar indirildiği için birkaç dakika sürebilir)'
& .\gradlew.bat --no-daemon --console=plain assembleRelease bundleRelease "-PtwaHost=$hostName"
if ($LASTEXITCODE) { throw 'Derleme başarısız. Yukarıdaki Gradle hatasına bak.' }

New-Item -ItemType Directory -Force 'dist' | Out-Null
$apk = "dist\KickReport-$version.apk"
$aab = "dist\KickReport-$version.aab"
Copy-Item 'app\build\outputs\apk\release\app-release.apk' $apk -Force
Copy-Item 'app\build\outputs\bundle\release\app-release.aab' $aab -Force
Step 'Hazır'
Write-Host "  Telefona kurmak için : android\$apk"
Write-Host "  Play Store için      : android\$aab"

# 6. Site doğrulaması (assetlinks.json) ------------------------------------
Step "https://$hostName/.well-known/assetlinks.json kontrol ediliyor"
try {
  $links = Invoke-RestMethod "https://$hostName/.well-known/assetlinks.json" -TimeoutSec 15
  $fps = @($links | ForEach-Object { $_.target.sha256_cert_fingerprints }) | ForEach-Object { $_ }
  if ($fps -contains $sha) {
    Write-Host '  Tamam: site bu uygulamayı tanıyor, uygulama adres çubuğu olmadan açılacak.' -ForegroundColor Green
  } else {
    Write-Host '  UYARI: sitedeki assetlinks.json bu imzayı içermiyor; uygulamada adres çubuğu görünür.' -ForegroundColor Yellow
    Write-Host "  Sunucuyu TWA_SHA256=$sha ile başlat (ya da sunucuyu bu klasörün bulunduğu projeden çalıştır)."
  }
} catch {
  Write-Host "  Site şu an erişilemiyor ($($_.Exception.Message))." -ForegroundColor Yellow
  Write-Host '  Site yayına girince sunucunun bu imzayı verdiğinden emin ol, yoksa uygulamada adres çubuğu görünür.'
}
