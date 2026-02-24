#!/bin/zsh
source ~/.zshrc

# Parse command line arguments
REFRESH_COUNT=""
FORCE_REFRESH=""
USE_GLOBAL=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --refresh-insights|-r)
            # --refresh-insights implies --force since we're explicitly requesting regeneration
            FORCE_REFRESH="--force"
            if [[ -n "$2" && "$2" != -* ]]; then
                REFRESH_COUNT="$2"
                shift 2
            else
                REFRESH_COUNT="5"  # Default to 5 if no number specified
                shift
            fi
            ;;
        --force|-f)
            FORCE_REFRESH="--force"
            shift
            ;;
        --global)
            USE_GLOBAL="--global"
            shift
            ;;
        --disable-ai-insights)
            export AI_INSIGHTS_ENABLED="false"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

nvm use v21.5.0

# Run sync first
yarn sync_garmin_cn_only

# If --refresh-insights was specified, run the refresh script
if [[ -n "$REFRESH_COUNT" ]]; then
    echo ""
    echo "=========================================="
    echo "Running AI Insights Refresh..."
    echo "=========================================="
    yarn refresh-insights --count "$REFRESH_COUNT" $FORCE_REFRESH $USE_GLOBAL
fi
