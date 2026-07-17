package local.flix.core.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "flix")

/** Local device prefs: the chosen server + session token (so onboarding/login
 *  are skipped on relaunch). Never stores a password — only the bearer token
 *  the server hands back on login (see POST /api/auth/login), same as the web
 *  client's localStorage token and the sibling Auralis native client. Library
 *  content and per-profile state (my list/ratings/progress) stay
 *  server-authoritative, fetched fresh on every launch. */
class Prefs(context: Context) {
    private val store = context.applicationContext.dataStore

    data class Snapshot(
        val serverBase: String,
        val token: String?,
        val username: String?,
        val avatar: String,
        val isAdmin: Boolean,
        val isKids: Boolean,
    )

    suspend fun load(): Snapshot {
        val p = store.data.first()
        return Snapshot(
            serverBase = p[SERVER_BASE].orEmpty(),
            token = p[TOKEN],
            username = p[USERNAME],
            avatar = p[AVATAR] ?: "red",
            isAdmin = p[IS_ADMIN] ?: false,
            isKids = p[IS_KIDS] ?: false,
        )
    }

    suspend fun setServer(base: String) {
        store.edit { it[SERVER_BASE] = base }
    }

    suspend fun setSession(token: String?, username: String?, avatar: String?, isAdmin: Boolean, isKids: Boolean) {
        store.edit {
            if (token != null) it[TOKEN] = token else it.remove(TOKEN)
            if (username != null) it[USERNAME] = username else it.remove(USERNAME)
            it[AVATAR] = avatar ?: "red"
            it[IS_ADMIN] = isAdmin
            it[IS_KIDS] = isKids
        }
    }

    suspend fun clearSession() {
        store.edit {
            it.remove(TOKEN)
            it.remove(USERNAME)
            it.remove(IS_ADMIN)
            it.remove(IS_KIDS)
        }
    }

    companion object {
        private val SERVER_BASE = stringPreferencesKey("server_base")
        private val TOKEN = stringPreferencesKey("token")
        private val USERNAME = stringPreferencesKey("username")
        private val AVATAR = stringPreferencesKey("avatar")
        private val IS_ADMIN = booleanPreferencesKey("is_admin")
        private val IS_KIDS = booleanPreferencesKey("is_kids")
    }
}
