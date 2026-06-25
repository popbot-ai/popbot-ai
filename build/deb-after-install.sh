#!/bin/bash
# Custom .deb postinst (electron-builder deb.afterInstall).
#
# Replaces electron-builder's default, which decides chrome-sandbox
# permissions by testing user namespaces — but it runs as ROOT during
# install (unrestricted), while the app runs as an unprivileged USER. On
# Ubuntu 24.04+ that user is blocked from unprivileged user namespaces
# (kernel.apparmor_restrict_unprivileged_userns), so the default leaves
# chrome-sandbox at 0755 and the app aborts with "The SUID sandbox helper
# binary was found, but is not configured correctly."
#
# Fix: set chrome-sandbox setuid-root unconditionally, exactly like
# Google Chrome's own .deb. The SUID sandbox is secure and works on every
# distro, so there's no downside to always using it.

# Launcher symlink (mirrors electron-builder's default behavior).
if type update-alternatives 2>/dev/null >&1; then
    if [ -L '/usr/bin/popbot' ] && [ -e '/usr/bin/popbot' ] && [ "$(readlink '/usr/bin/popbot')" != '/etc/alternatives/popbot' ]; then
        rm -f '/usr/bin/popbot'
    fi
    update-alternatives --install '/usr/bin/popbot' 'popbot' '/opt/PopBot/popbot' 100 || ln -sf '/opt/PopBot/popbot' '/usr/bin/popbot'
else
    ln -sf '/opt/PopBot/popbot' '/usr/bin/popbot'
fi

# The actual fix: setuid-root chrome-sandbox.
chmod 4755 '/opt/PopBot/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
