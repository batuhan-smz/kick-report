import java.util.Properties

plugins {
    id("com.android.application")
}

// Ayarlar: android/twa.properties (alan adı, uygulama adı, sürüm)
val twa = Properties().apply { rootProject.file("twa.properties").reader(Charsets.UTF_8).use { load(it) } }
val host: String = ((findProperty("twaHost") as String?) ?: twa.getProperty("host", "")).trim()
val siteHost = host.ifBlank { "alan-adi-girilmedi.invalid" }
if (host.isBlank()) logger.warn("UYARI: android/twa.properties içinde host boş. Gerçek APK için build.ps1 -Domain <alan-adi> kullanın.")
val launchUrl = "https://$siteHost/"

// İmza anahtarı: android/keystore/keystore.properties (build.ps1 ilk çalıştırmada oluşturur)
val keystoreFile = rootProject.file("keystore/keystore.properties")
val keystore = Properties().apply { if (keystoreFile.exists()) keystoreFile.reader(Charsets.UTF_8).use { load(it) } }

android {
    namespace = "com.kickreport.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.kickreport.app"
        minSdk = 24 // Android 7.0; androidbrowserhelper 2.7 bunu istiyor
        targetSdk = 36
        versionCode = twa.getProperty("versionCode", "1").toInt()
        versionName = twa.getProperty("versionName", "1.0.0")

        manifestPlaceholders["hostName"] = siteHost
        resValue("string", "app_name", twa.getProperty("appName", "Kick Report"))
        resValue("string", "launch_url", launchUrl)
        // Uygulama -> site yönündeki doğrulama (site -> uygulama yönü sitedeki /.well-known/assetlinks.json)
        resValue(
            "string", "asset_statements",
            """[{\"relation\": [\"delegate_permission/common.handle_all_urls\"], \"target\": {\"namespace\": \"web\", \"site\": \"https://$siteHost\"}}]""",
        )
    }

    buildFeatures {
        resValues = true
    }

    signingConfigs {
        if (keystoreFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystoreFile.exists()) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // Google'ın resmi TWA kütüphanesi: LauncherActivity, açılış ekranı, Chrome yoksa WebView'a düşme
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
}
