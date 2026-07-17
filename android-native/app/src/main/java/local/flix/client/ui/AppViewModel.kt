package local.flix.client.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import local.flix.core.data.Prefs
import local.flix.core.model.CatalogItem
import local.flix.core.model.LibrarySnapshot
import local.flix.core.model.MovieDetail
import local.flix.core.model.ProfileRef
import local.flix.core.model.RecommendResult
import local.flix.core.model.ShowDetail
import local.flix.core.model.UserState
import local.flix.core.model.filterForProfile
import local.flix.core.net.FlixApi
import local.flix.core.playback.PlaybackAuth
import local.flix.core.playback.PlayerHolder

enum class Phase { BOOT, CONNECT, PROFILES, LOGIN, LOADING, HOME, ERROR }

/** Simple in-app navigation stack — no Jetpack Navigation dependency needed
 *  for a handful of screens. */
sealed interface Screen {
    data object Home : Screen
    data object Search : Screen
    data class Detail(val type: String, val id: Int) : Screen
    data class Player(val type: String, val id: Int, val episodeId: Int? = null, val resumeMs: Long = 0L) : Screen
}

data class UiState(
    val phase: Phase = Phase.BOOT,
    val serverBase: String = "",
    val connecting: Boolean = false,
    val message: String? = null,

    val profiles: List<ProfileRef> = emptyList(),
    val selectedProfile: String? = null,

    val username: String? = null,
    val avatar: String = "red",
    val isAdmin: Boolean = false,
    val isKids: Boolean = false,

    val library: LibrarySnapshot = LibrarySnapshot.EMPTY,
    val recommend: RecommendResult = RecommendResult.EMPTY,
    val userState: UserState = UserState.EMPTY,

    val screen: Screen = Screen.Home,
    val backStack: List<Screen> = emptyList(),

    val searchQuery: String = "",
    val searchMovies: List<CatalogItem> = emptyList(),
    val searchShows: List<CatalogItem> = emptyList(),
    val searching: Boolean = false,

    val movieDetails: Map<Int, MovieDetail> = emptyMap(),
    val showDetails: Map<Int, ShowDetail> = emptyMap(),
) {
    /** Movies/shows visible to the CURRENT profile — kids gating applied
     *  client-side since /api/library is deliberately user-independent. */
    val visibleMovies: List<CatalogItem> get() = library.movies.filterForProfile(isKids)
    val visibleShows: List<CatalogItem> get() = library.shows.filterForProfile(isKids)
}

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = Prefs(app)
    val api = FlixApi()
    val player = PlayerHolder(app)

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        player.connect()
        boot()
    }

    override fun onCleared() {
        player.release()
        super.onCleared()
    }

    // ---- boot / auth ---------------------------------------------------------

    private fun boot() {
        viewModelScope.launch {
            val p = prefs.load()
            if (p.serverBase.isBlank()) {
                _ui.update { it.copy(phase = Phase.CONNECT) }
                return@launch
            }
            api.configure(p.serverBase, p.token)
            PlaybackAuth.token = p.token
            _ui.update { it.copy(serverBase = p.serverBase) }
            if (p.token.isNullOrBlank()) {
                loadProfiles(p.serverBase)
                return@launch
            }
            val status = api.status()
            if (status.ok) {
                api.setToken(status.token ?: p.token)
                PlaybackAuth.token = status.token ?: p.token
                prefs.setSession(status.token ?: p.token, status.username, status.avatar, status.isAdmin, status.isKids)
                _ui.update {
                    it.copy(username = status.username, avatar = status.avatar, isAdmin = status.isAdmin, isKids = status.isKids)
                }
                loadHome()
            } else {
                prefs.clearSession()
                loadProfiles(p.serverBase)
            }
        }
    }

    fun connect(rawBase: String) {
        val base = rawBase.trim()
        if (base.isBlank()) return
        viewModelScope.launch {
            // SECURITY: pointing at a (possibly new / untrusted) server must never
            // leak the PREVIOUS host's session bearer. Drop it BEFORE the first
            // request to the new base — otherwise the api.health() probe below
            // would carry the old Authorization header to a host it doesn't belong
            // to. A token is only re-established by logging into THIS server (see
            // login()); connect() always lands on the profile picker anyway.
            api.setToken(null)
            PlaybackAuth.token = null
            prefs.clearSession()
            _ui.update { it.copy(connecting = true, message = null) }
            val ok = api.health(base)
            if (!ok) {
                _ui.update { it.copy(connecting = false, message = "Serveur injoignable. Vérifiez l'adresse et le réseau.") }
                return@launch
            }
            val normalized = FlixApi.normalizeBase(base)
            api.configure(normalized, null)
            prefs.setServer(normalized)
            _ui.update { it.copy(serverBase = normalized, connecting = false) }
            loadProfiles(normalized)
        }
    }

    fun changeServer() {
        _ui.update { it.copy(phase = Phase.CONNECT, message = null, selectedProfile = null) }
    }

    private fun loadProfiles(base: String) {
        viewModelScope.launch {
            val profiles = api.accounts(base)
            _ui.update { it.copy(profiles = profiles, phase = Phase.PROFILES, message = null) }
        }
    }

    fun selectProfile(username: String) {
        _ui.update { it.copy(selectedProfile = username, phase = Phase.LOGIN, message = null) }
    }

    fun backToProfiles() {
        _ui.update { it.copy(selectedProfile = null, phase = Phase.PROFILES, message = null) }
    }

    fun login(password: String) {
        val username = _ui.value.selectedProfile ?: return
        viewModelScope.launch {
            _ui.update { it.copy(connecting = true, message = null) }
            val result = api.login(_ui.value.serverBase, username, password)
            if (!result.ok || result.token == null) {
                _ui.update { it.copy(connecting = false, message = result.error ?: "Connexion impossible") }
                return@launch
            }
            api.setToken(result.token)
            PlaybackAuth.token = result.token
            prefs.setSession(result.token, result.username ?: username, result.avatar, result.isAdmin, result.isKids)
            _ui.update {
                it.copy(
                    connecting = false, username = result.username ?: username, avatar = result.avatar,
                    isAdmin = result.isAdmin, isKids = result.isKids,
                )
            }
            loadHome()
        }
    }

    fun logout() {
        viewModelScope.launch {
            player.stop()
            prefs.clearSession()
            api.setToken(null)
            PlaybackAuth.token = null
            _ui.update {
                UiState(phase = Phase.PROFILES, serverBase = it.serverBase, profiles = it.profiles)
            }
        }
    }

    // ---- home / library --------------------------------------------------------

    fun loadHome() {
        viewModelScope.launch {
            _ui.update { it.copy(phase = Phase.LOADING) }
            try {
                val libraryDef = async { api.library() }
                val recoDef = async { api.recommend() }
                val stateDef = async { api.userState() }
                val library = libraryDef.await()
                val reco = recoDef.await()
                val state = stateDef.await()
                _ui.update { it.copy(phase = Phase.HOME, library = library, recommend = reco, userState = state, message = null) }
            } catch (t: Throwable) {
                _ui.update { it.copy(phase = Phase.ERROR, message = "Impossible de charger la bibliothèque : ${t.message}") }
            }
        }
    }

    fun refreshUserState() {
        viewModelScope.launch {
            val state = api.userState()
            _ui.update { it.copy(userState = state) }
        }
    }

    fun refreshRecommend() {
        viewModelScope.launch {
            val reco = api.recommend()
            _ui.update { it.copy(recommend = reco) }
        }
    }

    // ---- navigation --------------------------------------------------------

    fun navigate(screen: Screen) {
        _ui.update { it.copy(backStack = it.backStack + it.screen, screen = screen) }
    }

    /** Returns true if it consumed an in-app back step (caller should NOT also
     *  let the system back gesture close the activity). */
    fun back(): Boolean {
        val stack = _ui.value.backStack
        if (stack.isEmpty()) return false
        _ui.update { it.copy(screen = stack.last(), backStack = stack.dropLast(1)) }
        return true
    }

    fun openDetail(type: String, id: Int) {
        navigate(Screen.Detail(type, id))
        viewModelScope.launch {
            if (type == "movie" && !_ui.value.movieDetails.containsKey(id)) {
                api.movieDetail(id)?.let { d -> _ui.update { it.copy(movieDetails = it.movieDetails + (id to d)) } }
            } else if (type == "show" && !_ui.value.showDetails.containsKey(id)) {
                api.showDetail(id)?.let { d -> _ui.update { it.copy(showDetails = it.showDetails + (id to d)) } }
            }
        }
    }

    fun ensureShowDetail(id: Int, onLoaded: (ShowDetail) -> Unit = {}) {
        val cached = _ui.value.showDetails[id]
        if (cached != null) {
            onLoaded(cached)
            return
        }
        viewModelScope.launch {
            api.showDetail(id)?.let { d ->
                _ui.update { it.copy(showDetails = it.showDetails + (id to d)) }
                onLoaded(d)
            }
        }
    }

    fun play(type: String, id: Int, episodeId: Int? = null, resumeMs: Long = 0L) {
        navigate(Screen.Player(type, id, episodeId, resumeMs))
    }

    // ---- search --------------------------------------------------------------

    fun search(query: String) {
        _ui.update { it.copy(searchQuery = query) }
        if (query.isBlank()) {
            _ui.update { it.copy(searchMovies = emptyList(), searchShows = emptyList(), searching = false) }
            return
        }
        viewModelScope.launch {
            _ui.update { it.copy(searching = true) }
            val (movies, shows) = api.search(query)
            // Only apply if the query hasn't changed while we were waiting.
            if (_ui.value.searchQuery == query) {
                _ui.update { it.copy(searchMovies = movies.filterForProfile(it.isKids), searchShows = shows.filterForProfile(it.isKids), searching = false) }
            }
        }
    }

    // ---- per-profile state (my list / ratings) -------------------------------

    fun isInMyList(type: String, id: Int): Boolean = _ui.value.userState.myList.any { it.itemType == type && it.itemId == id }
    fun ratingFor(type: String, id: Int): Int? = _ui.value.userState.ratings.firstOrNull { it.itemType == type && it.itemId == id }?.value

    fun toggleMyList(type: String, id: Int) {
        val add = !isInMyList(type, id)
        _ui.update { state ->
            val filtered = state.userState.myList.filterNot { it.itemType == type && it.itemId == id }
            val next = if (add) filtered + local.flix.core.model.MyListEntry(type, id) else filtered
            state.copy(userState = state.userState.copy(myList = next))
        }
        viewModelScope.launch {
            api.toggleMyList(type, id, add)
            refreshRecommend()
        }
    }

    fun setRating(type: String, id: Int, value: Int) {
        _ui.update { state ->
            val filtered = state.userState.ratings.filterNot { it.itemType == type && it.itemId == id }
            val next = if (value == 0) filtered else filtered + local.flix.core.model.RatingEntry(type, id, value)
            state.copy(userState = state.userState.copy(ratings = next))
        }
        viewModelScope.launch {
            api.setRating(type, id, value)
            refreshRecommend()
        }
    }

    // ---- progress / watch events (called from PlayerScreen) -------------------

    fun saveProgress(itemType: String, itemId: Int, position: Double, duration: Double, mediaFileId: Int?) {
        viewModelScope.launch { api.setProgress(itemType, itemId, position, duration, mediaFileId) }
    }

    fun recordWatchEvent(itemType: String, itemId: Int, kind: String, ratio: Double, seconds: Double) {
        viewModelScope.launch { api.recordWatchEvent(itemType, itemId, kind, ratio, seconds) }
    }
}
