#!/bin/sh
set -eu

runtime_config_template='/usr/share/nginx/html/runtime-config.template.js'
runtime_config_output='/usr/share/nginx/html/runtime-config.js'

envsubst '${CARTO_BASEMAP_KEY} ${API_BASE_URL}' < "$runtime_config_template" > "$runtime_config_output"
