plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "local.flix.core"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        minSdk = 24
        // lint's target-sdk-version check runs even for a library module, so it
        // needs to be declared here too even though only an application's
        // targetSdk actually reaches the manifest.
        @Suppress("DEPRECATION")
        targetSdk = 36
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
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

// ui-tooling-preview (design-time @Preview annotations) isn't present in the
// offline cache for compose 1.9.1, and a headless APK build never needs it.
configurations.all {
    exclude(group = "androidx.compose.ui", module = "ui-tooling-preview")
}

// Pinned to artifacts verified present in the offline Gradle cache (same
// versions as /home/pc/Documents/auralis_enterprise_grade/android-native).
val composeVer = "1.9.1"
val media3Ver = "1.8.0"
val lifecycleVer = "2.9.4"

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")

    // Only the low-level UI primitives NetworkImage needs (Box/Image/Modifier) —
    // no material3 here, so :app (Material3) and :tv (androidx.tv material3)
    // can both depend on :core without pulling the wrong design system in.
    implementation("androidx.compose.ui:ui:$composeVer")
    implementation("androidx.compose.ui:ui-graphics:$composeVer")
    implementation("androidx.compose.foundation:foundation:$composeVer")

    implementation("androidx.lifecycle:lifecycle-runtime-ktx:$lifecycleVer")
    implementation("androidx.lifecycle:lifecycle-service:$lifecycleVer")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.datastore:datastore-preferences:1.2.0")

    // Networking — JSON parsed with android's built-in org.json (no
    // serialization plugin needed, keeps the offline build dependency-free).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Native playback + media session (lock-screen / notification controls).
    // media3-datasource-okhttp lets ExoPlayer share the same OkHttpClient (and
    // its Authorization-header interceptor) used for every other API call,
    // instead of a second raw java.net stack.
    implementation("androidx.media3:media3-exoplayer:$media3Ver")
    implementation("androidx.media3:media3-session:$media3Ver")
    implementation("androidx.media3:media3-common:$media3Ver")
    implementation("androidx.media3:media3-datasource-okhttp:$media3Ver")
}
