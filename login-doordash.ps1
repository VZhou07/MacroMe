$ErrorActionPreference = 'Stop'
wsl -d Ubuntu --cd $PSScriptRoot -- .venv/bin/python doordash_login.py @args
exit $LASTEXITCODE
