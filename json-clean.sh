#!/bin/sh

jq '[ .[] | ."$metadata".message ]' production.log.json > production.log.cleaned.json
