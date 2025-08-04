document.addEventListener('DOMContentLoaded', function() {
    const firstChoice = document.getElementById('first_choice');
    const deptQuestions = {
        Events: document.getElementById('events-question'),
        Operations: document.getElementById('operations-question'),
        Marketing: document.getElementById('marketing-question'),
        Outreach: document.getElementById('outreach-question'),
        Finance: document.getElementById('finance-question')
    };

    function showDeptQuestion() {
        Object.values(deptQuestions).forEach(div => div.style.display = 'none');
        const selected = firstChoice.value;
        if (deptQuestions[selected]) {
            deptQuestions[selected].style.display = 'block';
        }
    }

    firstChoice.addEventListener('change', showDeptQuestion);
    showDeptQuestion(); // Initial call in case of autofill

    // Limit file size for marketing portfolio
    const marketingPortfolio = document.getElementById('marketing_portfolio');
    if (marketingPortfolio) {
        marketingPortfolio.addEventListener('change', function(e) {
            for (let file of e.target.files) {
                if (file.size > 10 * 1024 * 1024) { // 10MB
                    alert('Each file must be less than 10MB.');
                    e.target.value = '';
                    break;
                }
            }
        });
    }
});
