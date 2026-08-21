module invalidate {
  var epoch: int
  var cachedAt: int
  var cacheValid: bool

  action init = all {
    epoch' = 0,
    cachedAt' = 0,
    cacheValid' = false,
  }

  action read = all {
    epoch' = epoch,
    cachedAt' = epoch,
    cacheValid' = true,
  }

  // Suspension invalidates facts derived from escaped/shared regions.
  action suspend = all {
    epoch' = epoch + 1,
    cachedAt' = cachedAt,
    cacheValid' = false,
  }

  action useCache = all {
    epoch' = epoch,
    cachedAt' = cachedAt,
    cacheValid' = cacheValid,
  }

  action step = any {
    read,
    suspend,
    useCache,
  }

  val cacheIsSound = not(cacheValid) or cachedAt == epoch
}
