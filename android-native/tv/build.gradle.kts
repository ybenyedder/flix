plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "local.flix.tv"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "local.flix.tv"
        minSdk = 24
        targetSdk = 36
        val tagVersion = (System.getenv("FLIX_VERSION") ?: "").trim().removePrefix("v")
        versionName = tagVersion.ifEmpty { "1.0.0" }
        versionCode = if (tagVersion.isEmpty()) 10000 else tagVersion.split(".").let { p ->
            fun n(i: Int) = p.getOrNull(i)?.toIntOrNull() ?: 0
            (n(0) * 10000 + n(1) * 100 + n(2)).coerceAtLeast(1)
        }
    }

    // Identifiants chargés depuis keystore.properties (gitignoré) ou l'env —
    // plus de mot de passe en dur (l'ancien avait fuité, keystore régénéré).
    val keystoreProps = java.util.Properties().apply {
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
    implementation("androidx.activity:activity-compose:1.10.0")

    implementation("androidx.compose.ui:ui:$composeVer")
    implementation("androidx.compose.ui:ui-graphics:$composeVer")
    implementation("androidx.compose.foundation:foundation:$composeVer")
    implementation("androidx.compose.animation:animation:$composeVer")
    // tv-material ships no loading spinner of its own — pull in just the
    // regular Material3 artifact (same pinned version as :app) for
    // CircularProgressIndicator; every other visible component in :tv comes
    // from androidx.tv.material3 below.
    implementation("androidx.compose.material3:material3:1.5.0-alpha08")
    // Compose for TV — Material Design components adapted for D-pad focus
    // (Surface/Card focus scale+glow, TV ColorScheme/Typography). Not present
    // in the offline cache (network-resolved once, like npm installs were for
    // the web app); its own compile dependency ceiling (compose foundation/ui
    // >= 1.6.8) is happily satisfied by the 1.9.1 pinned above.
    implementation("androidx.tv:tv-material:1.0.0")

    implementation("androidx.lifecycle:lifecycle-runtime-ktx:$lifecycleVer")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:$lifecycleVer")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:$lifecycleVer")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.datastore:datastore-preferences:1.2.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation("androidx.media3:media3-ui:$media3Ver")
    implementation("androidx.media3:media3-session:$media3Ver")
    implementation("androidx.media3:media3-common:$media3Ver")
}
