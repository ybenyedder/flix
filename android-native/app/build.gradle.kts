import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "local.flix.client"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "local.flix.client"
        minSdk = 24
        targetSdk = 36
        // FLIX_VERSION lets a packaging script stamp a real release tag; a
        // developer's own local build falls back to a high sentinel. There is
        // NO auto-update flow in Flix (unlike the sibling Auralis client) —
        // this only affects the "About" screen and Play Store-style versioning.
        val tagVersion = (System.getenv("FLIX_VERSION") ?: "").trim().removePrefix("v")
        versionName = tagVersion.ifEmpty { "1.0.0" }
        versionCode = if (tagVersion.isEmpty()) 10000 else tagVersion.split(".").let { p ->
            fun n(i: Int) = p.getOrNull(i)?.toIntOrNull() ?: 0
            (n(0) * 10000 + n(1) * 100 + n(2)).coerceAtLeast(1)
        }
    }

    // Stable signing key. Credentials loaded at build time from a gitignored
    // `keystore.properties` (or env: ANDROID_KEYSTORE_PWD / ANDROID_KEY_ALIAS /
    // ANDROID_KEY_PWD) — NO LONGER hardcoded (the previous key + password had
    // leaked publicly and have been regenerated).
    val keystoreProps = Properties().apply {
        val f = rootProject.file("keystore.properties")
        if (f.exists()) f.inputStream().use { load(it) }
    }
    fun signVal(k: String, env: String) = keystoreProps.getProperty(k) ?: System.getenv(env) ?: ""
    signingConfigs {
        getByName("debug") {
            storeFile = file("flix.keystore")
            storePassword = signVal("storePassword", "ANDROID_KEYSTORE_PWD")
            keyAlias = signVal("keyAlias", "ANDROID_KEY_ALIAS").ifEmpty { "flix" }
            keyPassword = signVal("keyPassword", "ANDROID_KEY_PWD")
        }
        create("release") {
            storeFile = file("flix.keystore")
            storePassword = signVal("storePassword", "ANDROID_KEYSTORE_PWD")
            keyAlias = signVal("keyAlias", "ANDROID_KEY_ALIAS").ifEmpty { "flix" }
            keyPassword = signVal("keyPassword", "ANDROID_KEY_PWD")
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "META-INF/*.kotlin_module")
        }
    }
}

configurations.all {
    exclude(group = "androidx.compose.ui", module = "ui-tooling-preview")
}

val composeVer = "1.9.1"
val media3Ver = "1.8.0"
val lifecycleVer = "2.9.4"

dependencies {
    implementation(project(":core"))

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.activity:activity-compose:1.10.0")

    implementation("androidx.compose.ui:ui:$composeVer")
    implementation("androidx.compose.ui:ui-graphics:$composeVer")
    implementation("androidx.compose.foundation:foundation:$composeVer")
    implementation("androidx.compose.animation:animation:$composeVer")
    implementation("androidx.compose.material3:material3:1.5.0-alpha08")
    implementation("androidx.compose.material:material-icons-extended:1.7.8")

    implementation("androidx.lifecycle:lifecycle-runtime-ktx:$lifecycleVer")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:$lifecycleVer")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:$lifecycleVer")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.datastore:datastore-preferences:1.2.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Native playback UI surface (PlayerView) — the ExoPlayer engine itself
    // lives in :core's PlaybackService, this just renders its output.
    implementation("androidx.media3:media3-ui:$media3Ver")
    implementation("androidx.media3:media3-session:$media3Ver")
    implementation("androidx.media3:media3-common:$media3Ver")
}
