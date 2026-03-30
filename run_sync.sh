#!/bin/zsh
source ~/.zshrc

# Parse command line arguments
REFRESH_COUNT=""
FORCE_REFRESH=""
USE_GLOBAL=""

# Function to show usage
usage() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  --refresh-insights, -r       Refresh insights for activities"
    echo "  --count, -n [n]              Number of activities to process (default 5)"
    echo "  --force, -f                  Force insight regeneration"
    echo "  --global                     Use Global account instead of CN"
    echo "  --download-all               Download all historical activities"
    echo "  --disable-ai-insights        Disable AI insight generation"
    echo "  --use-vertex, -v             Prioritize Vertex AI (Service Account) over Gemini API"
    echo "  --help, -h                   Show this help message"
    echo ""
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --help|-h)
            usage
            exit 0
            ;;
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
        --download-all)
            export GARMIN_MIGRATE_START=1
            shift
            ;;
        --disable-ai-insights)
            export AI_INSIGHTS_ENABLED="false"
            shift
            ;;
        --use-vertex|-v)
            export PRIORITIZE_VERTEX_AI="true"
            shift
            ;;
        --count|-n)
            if [[ -n "$2" && "$2" != -* ]]; then
                REFRESH_COUNT="$2"
                shift 2
            else
                echo "Error: --count requires a number"
                exit 1
            fi
            ;;
        *)
            shift
            ;;
    esac
done

nvm use v21.5.0

# Run sync first
REFRESH_COUNT=$REFRESH_COUNT yarn sync_garmin_cn_only

# If --refresh-insights was specified, run the refresh script
if [[ -n "$REFRESH_COUNT" ]]; then
    echo ""
    echo "=========================================="
    echo "Running AI Insights Refresh..."
    echo "=========================================="
    yarn refresh-insights --count "$REFRESH_COUNT" $FORCE_REFRESH $USE_GLOBAL
fi
